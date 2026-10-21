//! Ephemeral, bounded relay. Only the clients perform the PAKE or decrypt messages.
use std::{
    collections::{HashMap, VecDeque},
    net::{IpAddr, SocketAddr},
    sync::{Arc, Mutex},
    time::Duration,
};

use axum::{
    extract::{ConnectInfo, Path, Request, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::Response,
    routing::{delete, get, post},
    Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{de::DeserializeOwned, Serialize};
use serde_bytes::ByteBuf;
use tokio::time::Instant;

use crate::{
    auth, codec,
    routes::{
        document_response, empty, error_response, fail, read_body_with_deadline,
        SHORT_BODY_DEADLINE,
    },
    AppState, Error,
};

const ALPHABET: &[u8; 32] = b"23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const TTL: Duration = Duration::from_secs(120);
const MAX_ROOMS: usize = 256;
const MAX_PAKE_BODY: usize = 16_384;
const MAX_TRANSFER: usize = 1024 * 1024;
const MAX_BODY: usize = MAX_TRANSFER + 128;
const MAX_STORED_BYTES: usize = 16 * 1024 * 1024;
const MAX_MESSAGE: usize = 8192;
const JOIN_WINDOW: Duration = Duration::from_secs(60);
const SOURCE_JOIN_LIMIT: usize = 10;
const GLOBAL_JOIN_LIMIT: usize = 120;
type Rejection = (StatusCode, &'static str);

#[derive(Default)]
struct PairingState {
    rooms: HashMap<String, Room>,
    creations: HashMap<[u8; 32], VecDeque<Instant>>,
    joins: HashMap<Option<IpAddr>, VecDeque<Instant>>,
    global_joins: VecDeque<Instant>,
}

#[derive(Debug)]
enum Failure {
    Unavailable,
    Rejected(Rejection),
}

/// Clones share the relay. Synchronous operations never retain a lock across I/O.
#[derive(Clone, Default)]
pub(crate) struct Pairings {
    state: Arc<Mutex<PairingState>>,
}

impl Pairings {
    fn with_state<T>(
        &self,
        work: impl FnOnce(&mut PairingState, Instant) -> Result<T, Rejection>,
    ) -> Result<T, Failure> {
        let mut state = self.state.lock().map_err(|_| Failure::Unavailable)?;
        work(&mut state, Instant::now()).map_err(Failure::Rejected)
    }

    fn create(&self, owner: [u8; 32]) -> Result<Snapshot, Failure> {
        self.with_state(|state, now| state.create(owner, now))
    }
    fn admit_join(&self, source: Option<IpAddr>) -> Result<(), Failure> {
        self.with_state(|state, now| state.admit_join(source, now))
    }
    fn authorize(&self, id: &str, token: &str, source: Option<IpAddr>) -> Result<(), Failure> {
        self.with_state(|state, now| state.authorize(id, token, source, now).map(|_| ()))
    }
    fn join(&self, id: &str, message: ByteBuf) -> Result<Snapshot, Failure> {
        self.with_state(|state, now| state.join(id, message, now))
    }
    fn submit(
        &self,
        id: &str,
        token: &str,
        step: usize,
        message: ByteBuf,
    ) -> Result<Snapshot, Failure> {
        self.with_state(|state, now| state.submit(id, token, step, message, now))
    }
    fn poll(&self, id: &str, token: &str, source: Option<IpAddr>) -> Result<Snapshot, Failure> {
        self.with_state(|state, now| {
            state.authorize(id, token, source, now)?;
            state.room(id, now).map(|room| room.snapshot(id, now, None))
        })
    }
    fn cancel(&self, id: &str, token: &str, source: Option<IpAddr>) -> Result<(), Failure> {
        self.with_state(|state, now| {
            state.authorize(id, token, source, now)?;
            state.rooms.remove(id);
            tracing::info!(event = "pairing_canceled");
            Ok(())
        })
    }
}

struct Room {
    owner: [u8; 32],
    instance: String,
    created: Instant,
    sender: String,
    receiver: Option<String>,
    messages: Vec<ByteBuf>,
}

struct Snapshot {
    v: u8,
    id: String,
    instance: String,
    remaining_secs: u64,
    step: usize,
    message: Option<ByteBuf>,
    capability: Option<String>,
}

impl Room {
    fn snapshot(&self, id: &str, now: Instant, capability: Option<String>) -> Snapshot {
        Snapshot {
            v: 1,
            id: id.into(),
            instance: self.instance.clone(),
            remaining_secs: TTL
                .saturating_sub(now.duration_since(self.created))
                .as_secs(),
            step: self.messages.len(),
            message: self.messages.last().cloned(),
            capability,
        }
    }

    fn sender(&self, token: &str) -> Result<bool, Rejection> {
        if token_equal(&self.sender, token) {
            Ok(true)
        } else if self
            .receiver
            .as_ref()
            .is_some_and(|value| token_equal(value, token))
        {
            Ok(false)
        } else {
            Err((StatusCode::UNAUTHORIZED, "unauthorized"))
        }
    }
}

fn token_equal(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .fold(0, |diff, (a, b)| diff | (a ^ b))
            == 0
}

fn random(n: usize) -> Result<Vec<u8>, Rejection> {
    let mut bytes = vec![0; n];
    getrandom::getrandom(&mut bytes)
        .map_err(|_| (StatusCode::SERVICE_UNAVAILABLE, "service unavailable"))?;
    Ok(bytes)
}

fn capability() -> Result<String, Rejection> {
    Ok(URL_SAFE_NO_PAD.encode(random(32)?))
}

impl PairingState {
    // Use the TCP peer, never untrusted Forwarded/X-Forwarded-For headers.
    // Missing connection metadata shares one conservative source bucket.
    fn admit_join(&mut self, source: Option<IpAddr>, now: Instant) -> Result<(), Rejection> {
        let prune = |times: &mut VecDeque<Instant>| {
            while times
                .front()
                .is_some_and(|time| now.duration_since(*time) >= JOIN_WINDOW)
            {
                times.pop_front();
            }
        };
        prune(&mut self.global_joins);
        self.joins.retain(|_, times| {
            prune(times);
            !times.is_empty()
        });
        if self.global_joins.len() >= GLOBAL_JOIN_LIMIT
            || self
                .joins
                .get(&source)
                .is_some_and(|times| times.len() >= SOURCE_JOIN_LIMIT)
        {
            return Err((StatusCode::TOO_MANY_REQUESTS, "too many pairing requests"));
        }
        // Every inserted source has a live global entry, so both structures
        // contain at most GLOBAL_JOIN_LIMIT entries within this window.
        self.global_joins.push_back(now);
        self.joins.entry(source).or_default().push_back(now);
        Ok(())
    }

    fn authorize(
        &mut self,
        id: &str,
        token: &str,
        source: Option<IpAddr>,
        now: Instant,
    ) -> Result<bool, Rejection> {
        match self.room(id, now).and_then(|room| room.sender(token)) {
            Ok(sender) => Ok(sender),
            Err(error) => {
                // Otherwise callers could enumerate live IDs through the
                // participant endpoints, then spend join attempts only on hits.
                self.admit_join(source, now)?;
                Err(error)
            }
        }
    }

    fn prune(&mut self, now: Instant) {
        self.rooms
            .retain(|_, room| now.duration_since(room.created) < TTL);
        self.creations.retain(|_, times| {
            while times
                .front()
                .is_some_and(|time| now.duration_since(*time) >= Duration::from_secs(60))
            {
                times.pop_front();
            }
            !times.is_empty()
        });
    }

    fn create(&mut self, owner: [u8; 32], now: Instant) -> Result<Snapshot, Rejection> {
        self.prune(now);
        if self
            .creations
            .get(&owner)
            .is_some_and(|times| times.len() >= 5)
        {
            return Err((StatusCode::TOO_MANY_REQUESTS, "too many pairing requests"));
        }
        if self
            .rooms
            .values()
            .any(|room| room.owner == owner && room.messages.len() < 7)
        {
            return Err((StatusCode::CONFLICT, "a pairing is already active"));
        }
        if self.rooms.len() >= MAX_ROOMS || self.creations.len() >= 4096 {
            return Err((StatusCode::SERVICE_UNAVAILABLE, "pairing capacity reached"));
        }
        let id = loop {
            let id: String = random(4)?
                .into_iter()
                .map(|byte| ALPHABET[(byte & 31) as usize] as char)
                .collect();
            if !self.rooms.contains_key(&id) {
                break id;
            }
        };
        let room = Room {
            owner,
            instance: URL_SAFE_NO_PAD.encode(random(16)?),
            created: now,
            sender: capability()?,
            receiver: None,
            messages: Vec::new(),
        };
        let result = room.snapshot(&id, now, Some(room.sender.clone()));
        self.rooms.insert(id, room);
        self.creations.entry(owner).or_default().push_back(now);
        tracing::info!(event = "pairing_created");
        Ok(result)
    }

    // FIXME: use Instant consistently in other code that calls "now"?
    fn room(&mut self, id: &str, now: Instant) -> Result<&mut Room, Rejection> {
        self.prune(now);
        self.rooms
            .get_mut(id)
            .ok_or((StatusCode::NOT_FOUND, "pairing ended or expired"))
    }

    fn check_message_capacity(&self, additional: usize) -> Result<(), Rejection> {
        let stored: usize = self
            .rooms
            .values()
            .flat_map(|room| room.messages.iter())
            .map(|message| message.len())
            .sum();
        if additional > MAX_STORED_BYTES.saturating_sub(stored) {
            return Err((
                StatusCode::SERVICE_UNAVAILABLE,
                "pairing message capacity reached",
            ));
        }
        Ok(())
    }

    fn join(&mut self, id: &str, message: ByteBuf, now: Instant) -> Result<Snapshot, Rejection> {
        valid_message(&message, MAX_MESSAGE)?;
        self.prune(now);
        self.check_message_capacity(message.len())?;
        let room = self.room(id, now)?;
        if room.receiver.is_some() {
            return Err((StatusCode::CONFLICT, "pairing already has a receiver"));
        }
        let token = capability()?;
        room.receiver = Some(token.clone());
        room.messages.push(message);
        Ok(room.snapshot(id, now, Some(token)))
    }

    fn submit(
        &mut self,
        id: &str,
        token: &str,
        step: usize,
        message: ByteBuf,
        now: Instant,
    ) -> Result<Snapshot, Rejection> {
        valid_message(&message, if step == 4 { MAX_TRANSFER } else { MAX_MESSAGE })?;
        self.prune(now);
        if self
            .rooms
            .get(id)
            .is_none_or(|room| step > room.messages.len())
        {
            self.check_message_capacity(message.len())?;
        }
        let room = self.room(id, now)?;
        let sender = room.sender(token)?;
        if !(2..=7).contains(&step) || sender != step.is_multiple_of(2) {
            return Err((StatusCode::CONFLICT, "invalid pairing step"));
        }
        if step <= room.messages.len() {
            if room.messages[step - 1] != message {
                return Err((StatusCode::CONFLICT, "conflicting pairing message"));
            }
        } else if step == room.messages.len() + 1 {
            room.messages.push(message);
            if step == 7 {
                tracing::info!(event = "pairing_acknowledged");
            }
        } else {
            return Err((StatusCode::CONFLICT, "invalid pairing step"));
        }
        Ok(room.snapshot(id, now, None))
    }
}

fn valid_message(message: &[u8], maximum: usize) -> Result<(), Rejection> {
    if message.is_empty() || message.len() > maximum {
        Err((StatusCode::BAD_REQUEST, "invalid pairing message"))
    } else {
        Ok(())
    }
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/pairings", post(create))
        .route("/api/pairings/{id}", delete(cancel))
        .route("/api/pairings/{id}/join", post(join))
        .route("/api/pairings/{id}/messages", get(poll).post(submit))
}

fn result(value: Result<Snapshot, Failure>) -> Response {
    match value {
        Ok(value) => document_response(
            StatusCode::OK,
            (
                value.v,
                value.id,
                value.instance,
                value.remaining_secs,
                value.step,
                value.message,
                value.capability,
            ),
        ),
        Err(Failure::Unavailable) => fail(Error::Unavailable),
        Err(Failure::Rejected((status, message))) => {
            tracing::debug!(event = "pairing_rejected", status = status.as_u16());
            let mut response = error_response(status, message);
            if status == StatusCode::TOO_MANY_REQUESTS {
                response
                    .headers_mut()
                    .insert(header::RETRY_AFTER, HeaderValue::from_static("60"));
            }
            response
        }
    }
}

fn token(headers: &HeaderMap) -> &str {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .unwrap_or("")
}

fn source(request: &Request) -> Option<IpAddr> {
    request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|peer| peer.0.ip())
}

type Create = (u8,);
type Message = (ByteBuf,);
type Submission = (usize, ByteBuf);

async fn document_body<T: DeserializeOwned + Serialize>(
    request: Request,
    maximum: usize,
) -> Result<T, Box<Response>> {
    let bytes = read_body_with_deadline(request.into_body(), maximum, SHORT_BODY_DEADLINE).await?;
    let invalid = || Box::new(fail(Error::BadRequest("invalid pairing payload".into())));
    let value: T = codec::decode(&bytes).map_err(|_| invalid())?;
    let canonical = codec::encode(&value).map_err(|_| invalid())?;
    if canonical != bytes {
        return Err(invalid());
    }
    Ok(value)
}

async fn create(State(state): State<AppState>, request: auth::SignedRequest) -> Response {
    let (owner, bytes) = match request.read(MAX_PAKE_BODY, SHORT_BODY_DEADLINE).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    if !matches!(codec::decode::<Create>(&bytes), Ok((1,))) || bytes.as_ref() != [0x91, 1] {
        return fail(Error::BadRequest("invalid pairing version".into()));
    }
    result(state.pairings.create(owner))
}

async fn join(State(state): State<AppState>, Path(id): Path<String>, request: Request) -> Response {
    // Charge invalid IDs and malformed/stalled bodies before reading them.
    if let Err(error) = state.pairings.admit_join(source(&request)) {
        return result(Err(error));
    }
    let _permit = match state.permits.try_pairing_body() {
        Ok(permit) => permit,
        Err(_) => return fail(Error::Unavailable),
    };
    let message: Message = match document_body(request, MAX_PAKE_BODY).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    result(state.pairings.join(&id, message.0))
}

async fn submit(
    State(state): State<AppState>,
    Path(id): Path<String>,
    request: Request,
) -> Response {
    let token = token(request.headers()).to_owned();
    // Invalid capabilities must neither buffer a body nor occupy a read slot.
    if let Err(error) = state.pairings.authorize(&id, &token, source(&request)) {
        return result(Err(error));
    }
    let _permit = match state.permits.try_pairing_body() {
        Ok(permit) => permit,
        Err(_) => return fail(Error::Unavailable),
    };
    let message: Submission = match document_body(request, MAX_BODY).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    result(state.pairings.submit(&id, &token, message.0, message.1))
}

async fn poll(State(state): State<AppState>, Path(id): Path<String>, request: Request) -> Response {
    result(
        state
            .pairings
            .poll(&id, token(request.headers()), source(&request)),
    )
}

async fn cancel(
    State(state): State<AppState>,
    Path(id): Path<String>,
    request: Request,
) -> Response {
    match state
        .pairings
        .cancel(&id, token(request.headers()), source(&request))
    {
        Ok(()) => empty(StatusCode::NO_CONTENT),
        Err(error) => result(Err(error)),
    }
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    use super::*;

    #[tokio::test(start_paused = true)]
    async fn service_clones_share_cancellation_and_recheck_expiration() {
        let pairings = Pairings::default();
        let clone = pairings.clone();
        let created = pairings.create([1; 32]).unwrap();
        let token = created.capability.as_ref().unwrap();
        assert!(clone.poll(&created.id, token, None).is_ok());
        clone.cancel(&created.id, token, None).unwrap();
        assert!(matches!(
            pairings.poll(&created.id, token, None),
            Err(Failure::Rejected((StatusCode::NOT_FOUND, _)))
        ));
        let created = pairings.create([2; 32]).unwrap();
        let token = created.capability.as_ref().unwrap();
        pairings.authorize(&created.id, token, None).unwrap();
        tokio::time::advance(TTL).await;
        assert!(matches!(
            clone.submit(&created.id, token, 2, b"late body".to_vec().into()),
            Err(Failure::Rejected((StatusCode::NOT_FOUND, _)))
        ));
    }

    // Probe through admission rather than expose internal semaphore state.
    fn body_capacity(state: &AppState) -> usize {
        let mut held = Vec::new();
        while let Ok(permit) = state.permits.try_pairing_body() {
            held.push(permit);
        }
        held.len()
    }

    fn peer(number: u16) -> ConnectInfo<SocketAddr> {
        ConnectInfo(SocketAddr::new(
            IpAddr::V6(std::net::Ipv6Addr::new(
                0x2001, 0xdb8, 0, 0, 0, 0, 0, number,
            )),
            12345,
        ))
    }

    fn unread_body() -> Body {
        Body::new(Body::from("unread").map_frame(|_| panic!("rejected pairing body was read")))
    }

    #[test]
    fn anonymous_join_limits_bound_sources_and_recover_after_one_minute() {
        let now = Instant::now();
        let mut rooms = PairingState::default();
        let source = Some(peer(1).0.ip());
        for _ in 0..SOURCE_JOIN_LIMIT {
            rooms.admit_join(source, now).unwrap();
        }
        assert_eq!(
            rooms.admit_join(source, now).unwrap_err().0,
            StatusCode::TOO_MANY_REQUESTS
        );
        for number in 2..=(GLOBAL_JOIN_LIMIT - SOURCE_JOIN_LIMIT + 1) {
            rooms
                .admit_join(Some(peer(number as u16).0.ip()), now)
                .unwrap();
        }
        assert_eq!(rooms.global_joins.len(), GLOBAL_JOIN_LIMIT);
        assert_eq!(
            rooms.admit_join(Some(peer(500).0.ip()), now).unwrap_err().0,
            StatusCode::TOO_MANY_REQUESTS
        );
        assert!(!rooms.joins.contains_key(&Some(peer(500).0.ip())));
        assert!(rooms.joins.len() <= GLOBAL_JOIN_LIMIT);
        rooms.admit_join(source, now + JOIN_WINDOW).unwrap();
        assert_eq!(rooms.global_joins.len(), 1);
        assert_eq!(rooms.joins.len(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn malformed_and_missing_room_joins_are_limited_before_reading_and_headers_cannot_spoof_source(
    ) {
        let state = AppState::new(
            crate::db::Database::closed_for_test().await,
            "https://clip.example".into(),
        );
        let app = router().with_state(state);
        for number in 0..SOURCE_JOIN_LIMIT {
            let (body, expected) = if number.is_multiple_of(2) {
                (Body::from("not json"), StatusCode::BAD_REQUEST)
            } else {
                (
                    Body::from(codec::encode(&(ByteBuf::from(b"init".to_vec()),)).unwrap()),
                    StatusCode::NOT_FOUND,
                )
            };
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/api/pairings/XXXX/join")
                        .extension(peer(1))
                        .header("x-forwarded-for", format!("192.0.2.{number}"))
                        .body(body)
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), expected);
        }
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/pairings/OTHER/join")
                    .extension(peer(1))
                    .header("forwarded", "for=192.0.2.99")
                    .body(unread_body())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(response.headers()[header::RETRY_AFTER], "60");
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/pairings/XXXX/join")
                    .extension(peer(2))
                    .body(Body::from(
                        codec::encode(&(ByteBuf::from(b"init".to_vec()),)).unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        tokio::time::advance(JOIN_WINDOW).await;
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/pairings/XXXX/join")
                    .extension(peer(1))
                    .body(Body::from(
                        codec::encode(&(ByteBuf::from(b"init".to_vec()),)).unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test(start_paused = true)]
    async fn participant_endpoint_enumeration_shares_join_limits_but_valid_polling_remains_available(
    ) {
        let state = AppState::new(
            crate::db::Database::closed_for_test().await,
            "https://clip.example".into(),
        );
        let created = state.pairings.create([1; 32]).unwrap();
        let app = router().with_state(state);
        for number in 0..SOURCE_JOIN_LIMIT {
            let (method, path) = match number % 3 {
                0 => ("GET", "/api/pairings/MISSING/messages"),
                1 => ("POST", "/api/pairings/MISSING/messages"),
                _ => ("DELETE", "/api/pairings/MISSING"),
            };
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method(method)
                        .uri(path)
                        .extension(peer(1))
                        .body(unread_body())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::NOT_FOUND);
        }
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/api/pairings/{}/join", created.id))
                    .extension(peer(1))
                    .body(unread_body())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        for _ in 0..SOURCE_JOIN_LIMIT + 1 {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(format!("/api/pairings/{}/messages", created.id))
                        .extension(peer(1))
                        .header(
                            header::AUTHORIZATION,
                            format!("Bearer {}", created.capability.as_ref().unwrap()),
                        )
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
        }
    }

    #[tokio::test(start_paused = true)]
    async fn pairing_body_admission_rejects_without_reading_and_releases_on_cancel_error_success_and_timeout(
    ) {
        let state = AppState::new(
            crate::db::Database::closed_for_test().await,
            "https://clip.example".into(),
        );
        let created = state.pairings.create([1; 32]).unwrap();
        let app = router().with_state(state.clone());
        let mut tasks = Vec::new();
        let mut senders = Vec::new();
        for number in 0..16 {
            let (sender, body) = http_body_util::channel::Channel::<
                axum::body::Bytes,
                std::convert::Infallible,
            >::new(1);
            senders.push(sender);
            tasks.push(tokio::spawn(
                app.clone().oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/api/pairings/XXXX/join")
                        .extension(peer(number as u16 + 1))
                        .body(Body::new(body))
                        .unwrap(),
                ),
            ));
        }
        for _ in 0..100 {
            if body_capacity(&state) == 0 {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert_eq!(body_capacity(&state), 0);
        for (path, authorization, expected) in [
            (
                format!("/api/pairings/{}/join", created.id),
                "".into(),
                StatusCode::SERVICE_UNAVAILABLE,
            ),
            (
                format!("/api/pairings/{}/messages", created.id),
                "Bearer wrong".into(),
                StatusCode::UNAUTHORIZED,
            ),
            (
                format!("/api/pairings/{}/messages", created.id),
                format!("Bearer {}", created.capability.as_ref().unwrap()),
                StatusCode::SERVICE_UNAVAILABLE,
            ),
        ] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri(path)
                        .extension(peer(100))
                        .header(header::AUTHORIZATION, authorization)
                        .body(unread_body())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), expected);
        }
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/pairings/{}/messages", created.id))
                    .header(
                        header::AUTHORIZATION,
                        format!("Bearer {}", created.capability.as_ref().unwrap()),
                    )
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let canceled = tasks.pop().unwrap();
        canceled.abort();
        assert!(canceled.await.unwrap_err().is_cancelled());
        assert_eq!(body_capacity(&state), 1);
        for (body, expected) in [
            (b"not MessagePack".to_vec(), StatusCode::BAD_REQUEST),
            (
                codec::encode(&(ByteBuf::from(b"init".to_vec()),)).unwrap(),
                StatusCode::OK,
            ),
        ] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri(format!("/api/pairings/{}/join", created.id))
                        .extension(peer(100))
                        .body(Body::from(body))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), expected);
            assert_eq!(body_capacity(&state), 1);
        }
        tokio::time::advance(SHORT_BODY_DEADLINE).await;
        for task in tasks {
            assert_eq!(
                task.await.unwrap().unwrap().status(),
                StatusCode::REQUEST_TIMEOUT
            );
        }
        assert_eq!(body_capacity(&state), 16);
        drop(senders);
    }

    fn create_room(rooms: &mut PairingState, now: Instant) -> Snapshot {
        rooms.create([1; 32], now).unwrap()
    }

    #[test]
    fn ordered_exchange_is_idempotent_and_capabilities_are_role_scoped() {
        let now = Instant::now();
        let mut rooms = PairingState::default();
        let sender = create_room(&mut rooms, now);
        assert_eq!(sender.id.len(), 4);
        assert!(sender.id.bytes().all(|byte| ALPHABET.contains(&byte)));
        assert_eq!(sender.instance.len(), 22);
        let receiver = rooms
            .join(&sender.id, b"init".to_vec().into(), now)
            .unwrap();
        assert_eq!(
            rooms
                .join(&sender.id, b"other".to_vec().into(), now)
                .err()
                .unwrap()
                .0,
            StatusCode::CONFLICT
        );
        let send = sender.capability.unwrap();
        let recv = receiver.capability.unwrap();
        assert_ne!(send, recv);
        assert_eq!(
            rooms
                .submit(&sender.id, "wrong", 2, b"response".to_vec().into(), now)
                .err()
                .unwrap()
                .0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            rooms
                .submit(&sender.id, &recv, 2, b"response".to_vec().into(), now)
                .err()
                .unwrap()
                .0,
            StatusCode::CONFLICT
        );
        assert_eq!(
            rooms
                .submit(&sender.id, &send, 4, b"payload".to_vec().into(), now)
                .err()
                .unwrap()
                .0,
            StatusCode::CONFLICT
        );
        for (step, token, message) in [
            (2, &send, "response"),
            (3, &recv, "finish"),
            (4, &send, "payload"),
            (5, &recv, "prepared"),
            (6, &send, "enrolled"),
            (7, &recv, "active"),
        ] {
            assert_eq!(
                rooms
                    .submit(
                        &sender.id,
                        token,
                        step,
                        message.as_bytes().to_vec().into(),
                        now
                    )
                    .unwrap()
                    .step,
                step
            );
            assert_eq!(
                rooms
                    .submit(
                        &sender.id,
                        token,
                        step,
                        message.as_bytes().to_vec().into(),
                        now
                    )
                    .unwrap()
                    .step,
                step
            );
            assert_eq!(
                rooms
                    .submit(&sender.id, token, step, b"replacement".to_vec().into(), now)
                    .err()
                    .unwrap()
                    .0,
                StatusCode::CONFLICT
            );
        }
        assert_eq!(
            rooms
                .room(&sender.id, now)
                .unwrap()
                .snapshot(&sender.id, now, None)
                .message
                .as_ref()
                .map(|bytes| bytes.as_slice()),
            Some(b"active".as_slice())
        );
    }

    #[test]
    fn fixed_expiry_rejects_old_tokens_and_clears_capacity() {
        let now = Instant::now();
        let mut rooms = PairingState::default();
        let first = create_room(&mut rooms, now);
        rooms
            .join(
                &first.id,
                b"init".to_vec().into(),
                now + Duration::from_secs(119),
            )
            .unwrap();
        assert_eq!(
            rooms.room(&first.id, now + TTL).err().unwrap().0,
            StatusCode::NOT_FOUND
        );
        assert!(rooms.rooms.is_empty());
        assert!(rooms.creations.is_empty());
        let second = create_room(&mut rooms, now + TTL);
        assert_ne!(first.instance, second.instance);
        assert!(rooms
            .room(&second.id, now + TTL)
            .unwrap()
            .sender(first.capability.as_deref().unwrap())
            .is_err());
    }

    #[test]
    fn active_and_creation_limits_survive_cancel() {
        let now = Instant::now();
        let mut rooms = PairingState::default();
        let first = create_room(&mut rooms, now);
        assert_eq!(
            rooms.create([1; 32], now).err().unwrap().0,
            StatusCode::CONFLICT
        );
        rooms.rooms.remove(&first.id);
        for _ in 0..4 {
            let room = create_room(&mut rooms, now);
            rooms.rooms.remove(&room.id);
        }
        assert_eq!(
            rooms.create([1; 32], now).err().unwrap().0,
            StatusCode::TOO_MANY_REQUESTS
        );
        assert!(rooms.create([1; 32], now + Duration::from_secs(60)).is_ok());
    }

    #[test]
    fn room_capacity_and_message_limits_are_bounded() {
        let now = Instant::now();
        let mut rooms = PairingState::default();
        for number in 0..MAX_ROOMS {
            let mut owner = [0; 32];
            owner[..8].copy_from_slice(&number.to_be_bytes());
            rooms.create(owner, now).unwrap();
        }
        assert_eq!(rooms.rooms.len(), MAX_ROOMS);
        assert_eq!(
            rooms.create([255; 32], now).err().unwrap().0,
            StatusCode::SERVICE_UNAVAILABLE
        );
        let id = rooms.rooms.keys().next().unwrap().clone();
        assert!(rooms.join(&id, ByteBuf::new(), now).is_err());
        assert!(rooms
            .join(&id, vec![b'x'; MAX_MESSAGE + 1].into(), now)
            .is_err());
        assert!(rooms.join(&id, vec![b'x'; MAX_MESSAGE].into(), now).is_ok());
    }

    #[tokio::test]
    async fn relay_http_validates_capabilities_and_caps_unsigned_bodies() {
        let state = AppState::new(
            crate::db::Database::closed_for_test().await,
            "https://clip.example".into(),
        );
        let created = state.pairings.create([1; 32]).unwrap();
        let app = router().with_state(state);
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/pairings/{}/messages", created.id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/api/pairings/{}/join", created.id))
                    .body(Body::from("x".repeat(MAX_BODY + 1)))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(format!("/api/pairings/{}", created.id))
                    .header(
                        header::AUTHORIZATION,
                        format!("Bearer {}", created.capability.unwrap()),
                    )
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/pairings")
                    .body(Body::from(r#"{"v":1}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
    #[test]
    fn credential_transfers_have_phase_specific_and_aggregate_limits() {
        let now = Instant::now();
        let mut rooms = PairingState::default();
        let mut prepared = Vec::new();
        for number in 0..16 {
            let sender = rooms.create([number; 32], now).unwrap();
            let receiver = rooms.join(&sender.id, vec![1].into(), now).unwrap();
            let send = sender.capability.unwrap();
            let recv = receiver.capability.unwrap();
            rooms
                .submit(&sender.id, &send, 2, vec![2].into(), now)
                .unwrap();
            assert_eq!(
                rooms
                    .submit(&sender.id, &recv, 3, vec![3; MAX_MESSAGE + 1].into(), now)
                    .err()
                    .unwrap()
                    .0,
                StatusCode::BAD_REQUEST
            );
            rooms
                .submit(&sender.id, &recv, 3, vec![3].into(), now)
                .unwrap();
            prepared.push((sender.id, send, recv));
        }
        for (id, token, _) in &prepared[..15] {
            rooms
                .submit(id, token, 4, vec![4; MAX_TRANSFER].into(), now)
                .unwrap();
        }
        let (id, token, _) = &prepared[15];
        assert_eq!(
            rooms
                .submit(id, token, 4, vec![4; MAX_TRANSFER].into(), now)
                .err()
                .unwrap()
                .0,
            StatusCode::SERVICE_UNAVAILABLE
        );
        // Exact retries do not reserve another copy of their already stored packet.
        let (first, first_token, _) = &prepared[0];
        rooms
            .submit(first, first_token, 4, vec![4; MAX_TRANSFER].into(), now)
            .unwrap();
        rooms.rooms.remove(first);
        rooms
            .submit(id, token, 4, vec![4; MAX_TRANSFER].into(), now)
            .unwrap();
        let (_, _, receiver) = &prepared[15];
        assert_eq!(
            rooms
                .submit(id, receiver, 5, vec![5; MAX_MESSAGE + 1].into(), now)
                .err()
                .unwrap()
                .0,
            StatusCode::BAD_REQUEST
        );
        rooms.prune(now + TTL);
        assert!(rooms.rooms.is_empty());
        assert!(rooms.check_message_capacity(MAX_STORED_BYTES).is_ok());
    }

    #[test]
    fn fixed_relay_requests_reject_maps_and_extra_fields() {
        assert!(codec::decode::<Create>(&codec::encode(&(1_u8,)).unwrap()).is_ok());
        assert!(codec::decode::<Create>(&[0x81, 0xa1, b'v', 1]).is_err());
        assert!(codec::decode::<Create>(&codec::encode(&(1_u8, 2_u8)).unwrap()).is_err());
        assert!(
            codec::decode::<Message>(&codec::encode(&(ByteBuf::from(vec![1]),)).unwrap()).is_ok()
        );
    }
}

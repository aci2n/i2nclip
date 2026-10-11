//! Ephemeral, bounded relay. Only the clients perform the PAKE or decrypt messages.
use std::collections::{HashMap, VecDeque};
use std::time::Duration;

use axum::extract::{Path, Request, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::Response;
use axum::routing::{get, post};
use axum::Router;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::time::Instant;

use crate::routes::{empty, fail, json_response, read_body_with_deadline, SHORT_BODY_DEADLINE};
use crate::{auth, AppState, Error};

const ALPHABET: &[u8; 32] = b"23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const TTL: Duration = Duration::from_secs(120);
const MAX_ROOMS: usize = 256;
const MAX_BODY: usize = 16_384;
const MAX_MESSAGE: usize = 8192;
type Failure = (StatusCode, &'static str);

#[derive(Default)]
pub(crate) struct Pairings {
    rooms: HashMap<String, Room>,
    creations: HashMap<[u8; 32], VecDeque<Instant>>,
}

struct Room {
    owner: [u8; 32],
    instance: String,
    created: Instant,
    sender: String,
    receiver: Option<String>,
    messages: Vec<String>,
}

#[derive(Serialize)]
struct Snapshot {
    v: u8,
    id: String,
    instance: String,
    remaining_secs: u64,
    step: usize,
    message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
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

    fn sender(&self, token: &str) -> Result<bool, Failure> {
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

fn random(n: usize) -> Result<Vec<u8>, Failure> {
    let mut bytes = vec![0; n];
    getrandom::getrandom(&mut bytes)
        .map_err(|_| (StatusCode::SERVICE_UNAVAILABLE, "service unavailable"))?;
    Ok(bytes)
}

fn capability() -> Result<String, Failure> {
    Ok(URL_SAFE_NO_PAD.encode(random(32)?))
}

impl Pairings {
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

    fn create(&mut self, owner: [u8; 32], now: Instant) -> Result<Snapshot, Failure> {
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
            .any(|room| room.owner == owner && room.messages.len() < 5)
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
    fn room(&mut self, id: &str, now: Instant) -> Result<&mut Room, Failure> {
        self.prune(now);
        self.rooms
            .get_mut(id)
            .ok_or((StatusCode::NOT_FOUND, "pairing ended or expired"))
    }

    fn join(&mut self, id: &str, message: String, now: Instant) -> Result<Snapshot, Failure> {
        valid_message(&message)?;
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
        message: String,
        now: Instant,
    ) -> Result<Snapshot, Failure> {
        valid_message(&message)?;
        let room = self.room(id, now)?;
        let sender = room.sender(token)?;
        if !(2..=5).contains(&step) || sender != step.is_multiple_of(2) {
            return Err((StatusCode::CONFLICT, "invalid pairing step"));
        }
        if step <= room.messages.len() {
            if room.messages[step - 1] != message {
                return Err((StatusCode::CONFLICT, "conflicting pairing message"));
            }
        } else if step == room.messages.len() + 1 {
            room.messages.push(message);
            if step == 5 {
                tracing::info!(event = "pairing_acknowledged");
            }
        } else {
            return Err((StatusCode::CONFLICT, "invalid pairing step"));
        }
        Ok(room.snapshot(id, now, None))
    }
}

fn valid_message(message: &str) -> Result<(), Failure> {
    if message.is_empty() || message.len() > MAX_MESSAGE {
        Err((StatusCode::BAD_REQUEST, "invalid pairing message"))
    } else {
        Ok(())
    }
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/pairings", post(create))
        .route("/api/pairings/{id}", axum::routing::delete(cancel))
        .route("/api/pairings/{id}/join", post(join))
        .route("/api/pairings/{id}/messages", get(poll).post(submit))
}

fn result(value: Result<Snapshot, Failure>) -> Response {
    match value {
        Ok(value) => json_response(StatusCode::OK, value),
        Err((status, message)) => {
            tracing::debug!(event = "pairing_rejected", status = status.as_u16());
            json_response(status, json!({"error": message}))
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

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Create {
    v: u8,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Message {
    message: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Submission {
    step: usize,
    message: String,
}

async fn json_body<T: serde::de::DeserializeOwned>(request: Request) -> Result<T, Box<Response>> {
    let bytes = read_body_with_deadline(request.into_body(), MAX_BODY, SHORT_BODY_DEADLINE).await?;
    serde_json::from_slice(&bytes)
        .map_err(|_| Box::new(fail(Error::BadRequest("invalid pairing payload".into()))))
}

async fn create(State(state): State<AppState>, request: Request) -> Response {
    let verified = match auth::verify_request(
        &state,
        request.method(),
        request.uri(),
        request.headers(),
    )
    .await
    {
        Ok(value) => value,
        Err(error) => return fail(error),
    };
    let bytes =
        match read_body_with_deadline(request.into_body(), MAX_BODY, SHORT_BODY_DEADLINE).await {
            Ok(value) => value,
            Err(response) => return *response,
        };
    let owner = match auth::verify_body(&verified, &bytes).await {
        Ok(value) => value,
        Err(error) => return fail(error),
    };
    if !matches!(
        serde_json::from_slice::<Create>(&bytes),
        Ok(Create { v: 1 })
    ) {
        return fail(Error::BadRequest("invalid pairing version".into()));
    }
    match state.pairings.lock() {
        Ok(mut rooms) => result(rooms.create(owner, Instant::now())),
        Err(_) => fail(Error::Unavailable),
    }
}

async fn join(State(state): State<AppState>, Path(id): Path<String>, request: Request) -> Response {
    let message: Message = match json_body(request).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    match state.pairings.lock() {
        Ok(mut rooms) => result(rooms.join(&id, message.message, Instant::now())),
        Err(_) => fail(Error::Unavailable),
    }
}

async fn submit(
    State(state): State<AppState>,
    Path(id): Path<String>,
    request: Request,
) -> Response {
    let token = token(request.headers()).to_owned();
    let message: Submission = match json_body(request).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    match state.pairings.lock() {
        Ok(mut rooms) => {
            result(rooms.submit(&id, &token, message.step, message.message, Instant::now()))
        }
        Err(_) => fail(Error::Unavailable),
    }
}

async fn poll(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let now = Instant::now();
    match state.pairings.lock() {
        Ok(mut rooms) => result(rooms.room(&id, now).and_then(|room| {
            room.sender(token(&headers))?;
            Ok(room.snapshot(&id, now, None))
        })),
        Err(_) => fail(Error::Unavailable),
    }
}

async fn cancel(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let now = Instant::now();
    match state.pairings.lock() {
        Ok(mut rooms) => {
            if let Err(error) = rooms
                .room(&id, now)
                .and_then(|room| room.sender(token(&headers)))
            {
                return result(Err(error));
            }
            rooms.rooms.remove(&id);
            tracing::info!(event = "pairing_canceled");
            empty(StatusCode::NO_CONTENT)
        }
        Err(_) => fail(Error::Unavailable),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use tower::ServiceExt;

    fn create_room(rooms: &mut Pairings, now: Instant) -> Snapshot {
        rooms.create([1; 32], now).unwrap()
    }

    #[test]
    fn ordered_exchange_is_idempotent_and_capabilities_are_role_scoped() {
        let now = Instant::now();
        let mut rooms = Pairings::default();
        let sender = create_room(&mut rooms, now);
        assert_eq!(sender.id.len(), 4);
        assert!(sender.id.bytes().all(|byte| ALPHABET.contains(&byte)));
        assert_eq!(sender.instance.len(), 22);
        let receiver = rooms.join(&sender.id, "init".into(), now).unwrap();
        assert_eq!(
            rooms.join(&sender.id, "other".into(), now).err().unwrap().0,
            StatusCode::CONFLICT
        );
        let send = sender.capability.unwrap();
        let recv = receiver.capability.unwrap();
        assert_ne!(send, recv);
        assert_eq!(
            rooms
                .submit(&sender.id, "wrong", 2, "response".into(), now)
                .err()
                .unwrap()
                .0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            rooms
                .submit(&sender.id, &recv, 2, "response".into(), now)
                .err()
                .unwrap()
                .0,
            StatusCode::CONFLICT
        );
        assert_eq!(
            rooms
                .submit(&sender.id, &send, 4, "payload".into(), now)
                .err()
                .unwrap()
                .0,
            StatusCode::CONFLICT
        );
        for (step, token, message) in [
            (2, &send, "response"),
            (3, &recv, "finish"),
            (4, &send, "payload"),
            (5, &recv, "ack"),
        ] {
            assert_eq!(
                rooms
                    .submit(&sender.id, token, step, message.into(), now)
                    .unwrap()
                    .step,
                step
            );
            assert_eq!(
                rooms
                    .submit(&sender.id, token, step, message.into(), now)
                    .unwrap()
                    .step,
                step
            );
            assert_eq!(
                rooms
                    .submit(&sender.id, token, step, "replacement".into(), now)
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
                .as_deref(),
            Some("ack")
        );
    }

    #[test]
    fn fixed_expiry_rejects_old_tokens_and_clears_capacity() {
        let now = Instant::now();
        let mut rooms = Pairings::default();
        let first = create_room(&mut rooms, now);
        rooms
            .join(&first.id, "init".into(), now + Duration::from_secs(119))
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
        let mut rooms = Pairings::default();
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
        let mut rooms = Pairings::default();
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
        assert!(rooms.join(&id, String::new(), now).is_err());
        assert!(rooms.join(&id, "x".repeat(MAX_MESSAGE + 1), now).is_err());
        assert!(rooms.join(&id, "x".repeat(MAX_MESSAGE), now).is_ok());
    }

    #[tokio::test]
    async fn relay_http_validates_capabilities_and_caps_unsigned_bodies() {
        let state = AppState::new(
            crate::db::Database::closed_for_test().await,
            "https://clip.example".into(),
        );
        let created = state
            .pairings
            .lock()
            .unwrap()
            .create([1; 32], Instant::now())
            .unwrap();
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
}

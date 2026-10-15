//! Bounded public-endpoint windows, separate from IP trust and application work.
use std::collections::HashMap;
use std::net::IpAddr;
use std::time::Duration;

use axum::extract::{Request, State};
use axum::http::{header, HeaderValue, Method, StatusCode};
use axum::middleware::Next;
use axum::response::Response;
use serde_json::json;
use tokio::time::Instant;

use crate::client_ip::rate_key;
use crate::routes::{fail, json_response};
use crate::{AppState, Error};

const WINDOW: Duration = Duration::from_secs(60);
const MAX_BUCKETS: usize = 4096;
const GLOBAL_REGISTRATIONS: usize = 120;

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum Endpoint {
    Registration,
    Health,
}

struct Window {
    start: Instant,
    count: usize,
}

impl Window {
    fn remaining(&self, now: Instant) -> Duration {
        WINDOW.saturating_sub(now.duration_since(self.start))
    }
}

#[derive(Default)]
pub(crate) struct RateLimits {
    sources: HashMap<(Endpoint, Option<IpAddr>), Window>,
    registration: Option<Window>,
}

impl RateLimits {
    fn admit(
        &mut self,
        endpoint: Endpoint,
        source: Option<IpAddr>,
        now: Instant,
    ) -> Result<(), Duration> {
        self.sources
            .retain(|_, window| !window.remaining(now).is_zero());
        if endpoint == Endpoint::Registration {
            if self
                .registration
                .as_ref()
                .is_some_and(|window| window.remaining(now).is_zero())
            {
                self.registration = None;
            }
            if let Some(window) = &self.registration {
                if window.count >= GLOBAL_REGISTRATIONS {
                    return Err(window.remaining(now));
                }
            }
        }
        let key = (endpoint, rate_key(source));
        let limit = match endpoint {
            Endpoint::Registration => 10,
            Endpoint::Health => 120,
        };
        if let Some(window) = self.sources.get(&key) {
            if window.count >= limit {
                return Err(window.remaining(now));
            }
        } else if self.sources.len() == MAX_BUCKETS {
            return Err(WINDOW);
        }
        self.sources
            .entry(key)
            .or_insert(Window {
                start: now,
                count: 0,
            })
            .count += 1;
        if endpoint == Endpoint::Registration {
            self.registration
                .get_or_insert(Window {
                    start: now,
                    count: 0,
                })
                .count += 1;
        }
        Ok(())
    }
}

pub(crate) async fn public(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    let endpoint = match (request.method(), request.uri().path()) {
        (&Method::POST, "/api/register-key") => Endpoint::Registration,
        (&Method::GET | &Method::HEAD, "/api/health") => Endpoint::Health,
        _ => return next.run(request).await,
    };
    let admitted = match state.rate_limits.lock() {
        Ok(mut limits) => limits.admit(endpoint, state.client_ips.source(&request), Instant::now()),
        Err(_) => return fail(Error::Unavailable),
    };
    if let Err(remaining) = admitted {
        let retry = remaining.as_secs() + u64::from(remaining.subsec_nanos() > 0);
        let mut response = json_response(
            StatusCode::TOO_MANY_REQUESTS,
            json!({ "error": "too many requests" }),
        );
        response
            .headers_mut()
            .insert(header::RETRY_AFTER, HeaderValue::from(retry.max(1)));
        return response;
    }
    next.run(request).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::extract::ConnectInfo;
    use axum::http::Request as HttpRequest;
    use tower::ServiceExt;

    #[test]
    fn budgets_are_independent_and_rejections_do_not_extend_windows() {
        let mut limits = RateLimits::default();
        let now = Instant::now();
        let source = Some("192.0.2.1".parse().unwrap());
        for _ in 0..10 {
            limits.admit(Endpoint::Registration, source, now).unwrap();
        }
        assert_eq!(
            limits.admit(Endpoint::Registration, source, now + Duration::from_secs(5)),
            Err(Duration::from_secs(55))
        );
        limits.admit(Endpoint::Health, source, now).unwrap();
        limits
            .admit(
                Endpoint::Registration,
                Some("192.0.2.2".parse().unwrap()),
                now,
            )
            .unwrap();
        limits
            .admit(Endpoint::Registration, source, now + WINDOW)
            .unwrap();
        assert_eq!(limits.sources.len(), 1);
        for n in 0..9 {
            let ip = format!("2001:db8:1:1::{n}").parse().unwrap();
            limits
                .admit(Endpoint::Registration, Some(ip), now + WINDOW)
                .unwrap();
        }
        // One more is the tenth in this IPv6 /64; subsequent privacy addresses reject.
        limits
            .admit(
                Endpoint::Registration,
                Some("2001:db8:1:1::a".parse().unwrap()),
                now + WINDOW,
            )
            .unwrap();
        assert!(limits
            .admit(
                Endpoint::Registration,
                Some("2001:db8:1:1::b".parse().unwrap()),
                now + WINDOW
            )
            .is_err());
    }

    #[test]
    fn global_registration_budget_and_memory_bound_survive_source_rotation() {
        let mut limits = RateLimits::default();
        let now = Instant::now();
        for n in 0..GLOBAL_REGISTRATIONS {
            let ip = IpAddr::V4((0xc0000200_u32 + n as u32).into());
            limits.admit(Endpoint::Registration, Some(ip), now).unwrap();
        }
        assert_eq!(limits.admit(Endpoint::Registration, None, now), Err(WINDOW));
        limits
            .admit(Endpoint::Registration, None, now + WINDOW)
            .unwrap();
        let mut limits = RateLimits::default();
        for n in 0..MAX_BUCKETS {
            limits
                .admit(Endpoint::Health, Some(IpAddr::V4((n as u32).into())), now)
                .unwrap();
        }
        assert_eq!(limits.admit(Endpoint::Health, None, now), Err(WINDOW));
        assert_eq!(limits.sources.len(), MAX_BUCKETS);
        limits
            .admit(Endpoint::Health, Some(IpAddr::V4(0_u32.into())), now)
            .unwrap();
        limits.admit(Endpoint::Health, None, now + WINDOW).unwrap();
        assert_eq!(limits.sources.len(), 1);
    }

    async fn app(trusted: &str) -> axum::Router {
        let db = crate::db::Database::closed_for_test().await;
        let mut state = AppState::new(db, "http://i2nclip.test".into());
        state.client_ips = crate::client_ip::ClientIps::parse(trusted).unwrap();
        crate::routes::router(state)
    }

    fn request(source: &str, forwarded: &str, body: Body) -> Request {
        let mut request = HttpRequest::builder()
            .method("POST")
            .uri("/api/register-key")
            .header("x-forwarded-for", forwarded)
            .header("authorization", "Bearer does-not-bypass-public-limits")
            .body(body)
            .unwrap();
        request
            .extensions_mut()
            .insert(ConnectInfo(source.parse::<std::net::SocketAddr>().unwrap()));
        request
    }

    #[tokio::test(start_paused = true)]
    async fn http_limits_precede_body_reads_and_spoofed_headers_cannot_reset_them() {
        use http_body_util::BodyExt;
        let app = app("").await;
        for n in 0..10 {
            let response = app
                .clone()
                .oneshot(request(
                    "192.0.2.1:1234",
                    &format!("198.51.100.{n}"),
                    Body::from("invalid json"),
                ))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        }
        tokio::time::advance(Duration::from_millis(1250)).await;
        let response = app
            .clone()
            .oneshot(request(
                "192.0.2.1:4567",
                "203.0.113.1",
                Body::new(Body::from("unread").map_frame(|_| panic!("limited body was read"))),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(response.headers()[header::RETRY_AFTER], "59");
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(
            app.clone()
                .oneshot(request(
                    "192.0.2.2:1234",
                    "203.0.113.1",
                    Body::from("invalid")
                ))
                .await
                .unwrap()
                .status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            app.clone()
                .oneshot(
                    HttpRequest::builder()
                        .uri("/api/health")
                        .body(Body::empty())
                        .unwrap()
                )
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        tokio::time::advance(WINDOW).await;
        assert_eq!(
            app.oneshot(request(
                "192.0.2.1:1234",
                "203.0.113.1",
                Body::from("invalid")
            ))
            .await
            .unwrap()
            .status(),
            StatusCode::BAD_REQUEST
        );
    }

    #[tokio::test]
    async fn trusted_proxy_clients_have_separate_budgets_and_health_is_bounded() {
        let app = app("127.0.0.1").await;
        for _ in 0..10 {
            assert_eq!(
                app.clone()
                    .oneshot(request(
                        "127.0.0.1:1234",
                        "198.51.100.1",
                        Body::from("invalid")
                    ))
                    .await
                    .unwrap()
                    .status(),
                StatusCode::BAD_REQUEST
            );
        }
        assert_eq!(
            app.clone()
                .oneshot(request(
                    "127.0.0.1:1234",
                    "spoofed,198.51.100.1",
                    Body::empty()
                ))
                .await
                .unwrap()
                .status(),
            StatusCode::TOO_MANY_REQUESTS
        );
        assert_eq!(
            app.clone()
                .oneshot(request(
                    "127.0.0.1:1234",
                    "198.51.100.2",
                    Body::from("invalid")
                ))
                .await
                .unwrap()
                .status(),
            StatusCode::BAD_REQUEST
        );
        for _ in 0..120 {
            assert_eq!(
                app.clone()
                    .oneshot(
                        HttpRequest::builder()
                            .uri("/api/health")
                            .body(Body::empty())
                            .unwrap()
                    )
                    .await
                    .unwrap()
                    .status(),
                StatusCode::OK
            );
        }
        assert_eq!(
            app.oneshot(
                HttpRequest::builder()
                    .uri("/api/health")
                    .body(Body::empty())
                    .unwrap()
            )
            .await
            .unwrap()
            .status(),
            StatusCode::TOO_MANY_REQUESTS
        );
    }
}

#[cfg(all(test, feature = "postgres-tests"))]
mod listener_tests {
    use super::*;
    use std::net::SocketAddr;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    struct Server(Option<tokio::task::JoinHandle<Result<(), std::io::Error>>>);
    impl Drop for Server {
        fn drop(&mut self) {
            if let Some(task) = self.0.take() {
                task.abort();
            }
        }
    }

    async fn post(address: SocketAddr, ip: &str) -> String {
        tokio::time::timeout(Duration::from_secs(5), async {
            let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
            stream.write_all(format!(
                "POST /api/register-key HTTP/1.1\r\nHost: localhost\r\nX-Forwarded-For: {ip}\r\nContent-Length: 1\r\nConnection: close\r\n\r\nx",
            ).as_bytes()).await.unwrap();
            let mut response = Vec::new();
            stream.read_to_end(&mut response).await.unwrap();
            String::from_utf8(response).unwrap()
        }).await.unwrap()
    }

    #[tokio::test]
    async fn real_listener_distinguishes_sanitized_proxy_clients_but_ignores_untrusted_headers() {
        for trusted in ["127.0.0.1", ""] {
            let db = crate::db::Database::closed_for_test().await;
            let mut state = AppState::new(db, "http://i2nclip.test".into());
            state.client_ips = crate::client_ip::ClientIps::parse(trusted).unwrap();
            let router = crate::routes::router(state);
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let mut server = Server(Some(tokio::spawn(async move {
                axum::serve(
                    listener,
                    router.into_make_service_with_connect_info::<SocketAddr>(),
                )
                .await
            })));
            for _ in 0..10 {
                assert!(post(address, "198.51.100.1")
                    .await
                    .starts_with("HTTP/1.1 400"));
            }
            let limited = post(address, "198.51.100.1").await;
            assert!(limited.starts_with("HTTP/1.1 429"));
            assert!(limited.to_ascii_lowercase().contains("retry-after:"));
            let expected = if trusted.is_empty() {
                "HTTP/1.1 429"
            } else {
                "HTTP/1.1 400"
            };
            assert!(post(address, "198.51.100.2").await.starts_with(expected));
            if let Some(task) = server.0.take() {
                task.abort();
                assert!(task.await.unwrap_err().is_cancelled());
            }
        }
    }
}

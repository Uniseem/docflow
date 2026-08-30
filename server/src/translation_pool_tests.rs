use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::task::JoinHandle;

const TEST_TIMEOUT: Duration = Duration::from_secs(5);
const NO_START_WINDOW: Duration = Duration::from_millis(40);

struct FakeJob {
    id: usize,
    release: oneshot::Receiver<()>,
}

struct FakePool {
    sender: Option<mpsc::Sender<FakeJob>>,
    limit: Option<watch::Sender<usize>>,
    started: mpsc::UnboundedReceiver<usize>,
    finished: mpsc::UnboundedReceiver<usize>,
    active: Arc<AtomicUsize>,
    peak: Arc<AtomicUsize>,
    dispatcher: JoinHandle<()>,
}

impl FakePool {
    fn new(concurrency: usize) -> Self {
        let (sender, receiver) = mpsc::channel(32);
        let (limit, limits) = watch::channel(concurrency);
        let (started_sender, started) = mpsc::unbounded_channel();
        let (finished_sender, finished) = mpsc::unbounded_channel();
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let worker_active = active.clone();
        let worker_peak = peak.clone();
        let dispatcher = tokio::spawn(dispatch(receiver, limits, move |job: FakeJob| {
            let active = worker_active.clone();
            let peak = worker_peak.clone();
            let started = started_sender.clone();
            let finished = finished_sender.clone();
            async move {
                let current = active.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(current, Ordering::SeqCst);
                let _ = started.send(job.id);
                let _ = job.release.await;
                active.fetch_sub(1, Ordering::SeqCst);
                let _ = finished.send(job.id);
            }
        }));
        Self {
            sender: Some(sender),
            limit: Some(limit),
            started,
            finished,
            active,
            peak,
            dispatcher,
        }
    }

    async fn enqueue(
        &self,
        ids: impl IntoIterator<Item = usize>,
    ) -> HashMap<usize, oneshot::Sender<()>> {
        let mut releases = HashMap::new();
        for id in ids {
            let (release, receiver) = oneshot::channel();
            self.sender
                .as_ref()
                .expect("test queue is open")
                .send(FakeJob {
                    id,
                    release: receiver,
                })
                .await
                .expect("test dispatcher accepts queued jobs");
            releases.insert(id, release);
        }
        releases
    }

    fn set_limit(&self, concurrency: usize) {
        self.limit
            .as_ref()
            .expect("test limit channel is open")
            .send(concurrency)
            .expect("test dispatcher receives limit updates");
    }

    async fn next_started(&mut self) -> usize {
        tokio::time::timeout(TEST_TIMEOUT, self.started.recv())
            .await
            .expect("queued job should start before test timeout")
            .expect("started event channel should remain open")
    }

    async fn next_finished(&mut self) -> usize {
        tokio::time::timeout(TEST_TIMEOUT, self.finished.recv())
            .await
            .expect("released job should finish before test timeout")
            .expect("finished event channel should remain open")
    }

    async fn assert_no_start(&mut self) {
        assert!(
            tokio::time::timeout(NO_START_WINDOW, self.started.recv())
                .await
                .is_err(),
            "a full or draining pool must not start another queued job"
        );
    }

    fn active(&self) -> usize {
        self.active.load(Ordering::SeqCst)
    }

    fn close(&mut self) {
        drop(self.sender.take());
        drop(self.limit.take());
    }

    async fn assert_drained(&mut self) {
        tokio::time::timeout(TEST_TIMEOUT, &mut self.dispatcher)
            .await
            .expect("closed dispatcher should drain and exit")
            .expect("dispatcher should not panic");
        assert_eq!(self.active(), 0);
    }
}

impl Drop for FakePool {
    fn drop(&mut self) {
        // Avoid detached, blocked fake jobs if a test assertion fails.
        self.dispatcher.abort();
    }
}

fn release(releases: &mut HashMap<usize, oneshot::Sender<()>>, id: usize) {
    releases
        .remove(&id)
        .expect("each fake job is released once")
        .send(())
        .expect("an in-flight fake job must not have been cancelled");
}

#[tokio::test]
async fn dispatcher_increases_concurrency_without_exceeding_the_new_limit() {
    let mut pool = FakePool::new(1);
    let mut releases = pool.enqueue(0..4).await;
    assert_eq!(pool.next_started().await, 0);
    pool.assert_no_start().await;
    assert_eq!(pool.active(), 1);

    pool.set_limit(3);
    let mut newly_started = [pool.next_started().await, pool.next_started().await];
    newly_started.sort_unstable();
    assert_eq!(newly_started, [1, 2]);
    assert_eq!(pool.active(), 3);
    pool.assert_no_start().await;

    release(&mut releases, 0);
    assert_eq!(pool.next_finished().await, 0);
    assert_eq!(pool.next_started().await, 3);
    assert_eq!(pool.active(), 3);
    for id in 1..4 {
        release(&mut releases, id);
    }
    for _ in 1..4 {
        pool.next_finished().await;
    }
    pool.close();
    pool.assert_drained().await;
    assert_eq!(pool.peak.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn dispatcher_decrease_drains_existing_jobs_without_cancelling_them() {
    let mut pool = FakePool::new(3);
    let mut releases = pool.enqueue(0..5).await;
    let mut initial = [
        pool.next_started().await,
        pool.next_started().await,
        pool.next_started().await,
    ];
    initial.sort_unstable();
    assert_eq!(initial, [0, 1, 2]);

    pool.set_limit(1);
    pool.assert_no_start().await;
    assert_eq!(pool.active(), 3);
    for id in 0..3 {
        assert!(!releases[&id].is_closed());
    }
    release(&mut releases, 0);
    assert_eq!(pool.next_finished().await, 0);
    pool.assert_no_start().await;
    assert_eq!(pool.active(), 2);
    release(&mut releases, 1);
    assert_eq!(pool.next_finished().await, 1);
    pool.assert_no_start().await;
    assert_eq!(pool.active(), 1);

    release(&mut releases, 2);
    assert_eq!(pool.next_finished().await, 2);
    assert_eq!(pool.next_started().await, 3);
    assert_eq!(pool.active(), 1);
    pool.assert_no_start().await;
    release(&mut releases, 3);
    assert_eq!(pool.next_finished().await, 3);
    assert_eq!(pool.next_started().await, 4);
    assert_eq!(pool.active(), 1);
    release(&mut releases, 4);
    assert_eq!(pool.next_finished().await, 4);
    pool.close();
    pool.assert_drained().await;
    assert_eq!(pool.peak.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn dispatcher_drains_queued_jobs_after_both_input_channels_close() {
    let mut pool = FakePool::new(2);
    let mut releases = pool.enqueue(0..4).await;
    let mut initial = [pool.next_started().await, pool.next_started().await];
    initial.sort_unstable();
    assert_eq!(initial, [0, 1]);
    pool.close();
    assert!(!pool.dispatcher.is_finished());

    release(&mut releases, 0);
    assert_eq!(pool.next_finished().await, 0);
    assert_eq!(pool.next_started().await, 2);
    release(&mut releases, 1);
    assert_eq!(pool.next_finished().await, 1);
    assert_eq!(pool.next_started().await, 3);
    release(&mut releases, 2);
    release(&mut releases, 3);
    let mut final_ids = [pool.next_finished().await, pool.next_finished().await];
    final_ids.sort_unstable();
    assert_eq!(final_ids, [2, 3]);
    pool.assert_drained().await;
    assert_eq!(pool.peak.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn dispatcher_keeps_the_last_limit_when_only_the_watch_channel_closes() {
    let mut pool = FakePool::new(1);
    drop(pool.limit.take());
    let mut releases = pool.enqueue(0..2).await;
    assert_eq!(pool.next_started().await, 0);
    pool.assert_no_start().await;
    release(&mut releases, 0);
    assert_eq!(pool.next_finished().await, 0);
    assert_eq!(pool.next_started().await, 1);
    release(&mut releases, 1);
    assert_eq!(pool.next_finished().await, 1);
    pool.close();
    pool.assert_drained().await;
    assert_eq!(pool.peak.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn two_provider_dispatchers_have_independent_limits_and_shutdown() {
    let mut google = FakePool::new(1);
    let mut deepseek = FakePool::new(2);
    let mut google_releases = google.enqueue(0..2).await;
    let mut deepseek_releases = deepseek.enqueue(10..13).await;
    assert_eq!(google.next_started().await, 0);
    let mut initial = [deepseek.next_started().await, deepseek.next_started().await];
    initial.sort_unstable();
    assert_eq!(initial, [10, 11]);

    google.set_limit(3);
    assert_eq!(google.next_started().await, 1);
    deepseek.assert_no_start().await;
    assert_eq!(google.active(), 2);
    assert_eq!(deepseek.active(), 2);

    deepseek.set_limit(1);
    release(&mut google_releases, 0);
    release(&mut google_releases, 1);
    google.next_finished().await;
    google.next_finished().await;
    google.close();
    google.assert_drained().await;
    assert_eq!(deepseek.active(), 2);
    assert!(!deepseek.dispatcher.is_finished());

    release(&mut deepseek_releases, 10);
    assert_eq!(deepseek.next_finished().await, 10);
    deepseek.assert_no_start().await;
    assert_eq!(deepseek.active(), 1);
    release(&mut deepseek_releases, 11);
    assert_eq!(deepseek.next_finished().await, 11);
    assert_eq!(deepseek.next_started().await, 12);
    release(&mut deepseek_releases, 12);
    assert_eq!(deepseek.next_finished().await, 12);
    deepseek.close();
    deepseek.assert_drained().await;
    assert_eq!(deepseek.peak.load(Ordering::SeqCst), 2);
}

fn deepseek_response(segments: Value) -> Value {
    json!({
        "choices": [{
            "finish_reason": "stop",
            "message": {"content": json!({"segments": segments}).to_string()}
        }]
    })
}

#[test]
fn deepseek_batch_results_are_reordered_by_the_submitted_ids() {
    let response = deepseek_response(json!([
        {"id": 23, "text": "第三段"},
        {"id": 11, "text": "第一段"},
        {"id": 7, "text": "第二段"}
    ]));
    assert_eq!(
        decode_deepseek(&response, Some(&[11, 7, 23])).unwrap(),
        ["第一段", "第二段", "第三段"]
    );
}

#[test]
fn deepseek_batch_rejects_duplicate_unknown_missing_extra_or_invalid_ids() {
    for segments in [
        json!([{"id": 7, "text": "a"}, {"id": 7, "text": "b"}]),
        json!([{"id": 7, "text": "a"}, {"id": 9, "text": "b"}]),
        json!([{"id": 7, "text": "a"}]),
        json!([
            {"id": 7, "text": "a"}, {"id": 8, "text": "b"}, {"id": 9, "text": "c"}
        ]),
        json!([{"id": "7", "text": "a"}, {"id": 8, "text": "b"}]),
        json!([{"id": -7, "text": "a"}, {"id": 8, "text": "b"}]),
        json!([{"id": 7.5, "text": "a"}, {"id": 8, "text": "b"}]),
        json!([{"text": "a"}, {"id": 8, "text": "b"}]),
    ] {
        let response = deepseek_response(segments);
        let error = decode_deepseek(&response, Some(&[7, 8])).unwrap_err();
        assert!(error.split_retry);
        assert!(!error.retryable);
    }
}

#[test]
fn deepseek_batch_rejects_empty_text_and_malformed_json() {
    for text in [json!(""), json!(" \n\t"), json!(null), json!(42)] {
        let response = deepseek_response(json!([{"id": 7, "text": text}]));
        assert!(decode_deepseek(&response, Some(&[7])).is_err());
    }
    for content in ["not json", "[]", "{}", "{\"segments\":null}"] {
        let response = json!({
            "choices": [{"finish_reason": "stop", "message": {"content": content}}]
        });
        assert!(decode_deepseek(&response, Some(&[7])).is_err());
    }
}

#[test]
fn deepseek_rejects_truncated_or_non_final_outputs_even_when_the_json_is_complete() {
    for finish in ["length", "content_filter", "tool_calls", ""] {
        let mut response = deepseek_response(json!([{"id": 7, "text": "完整 JSON 中的译文"}]));
        response["choices"][0]["finish_reason"] = json!(finish);
        let error = decode_deepseek(&response, Some(&[7])).unwrap_err();
        assert!(error.split_retry);
    }
    let response = json!({
        "choices": [{"finish_reason": "stop", "message": {"reasoning_content": "只有思考"}}]
    });
    assert!(decode_deepseek(&response, None).is_err());
}

#[test]
fn deepseek_single_segment_accepts_plain_final_text() {
    let response = json!({
        "choices": [{"finish_reason": "stop", "message": {"content": "保留 Markdown **正文**"}}]
    });
    assert_eq!(
        decode_deepseek(&response, None).unwrap(),
        ["保留 Markdown **正文**"]
    );
}

#[test]
fn google_batch_preserves_array_order_and_decodes_html_entities() {
    let response = json!({"data": {"translations": [
        {"translatedText": "第一段 &amp; 内容"},
        {"translatedText": "第二段 &#39;引用&#39;"}
    ]}});
    assert_eq!(
        decode_google(&response, 2).unwrap(),
        ["第一段 & 内容", "第二段 '引用'"]
    );
}

#[test]
fn google_batch_rejects_mismatched_counts_and_empty_translations() {
    for response in [
        json!({"data": {"translations": []}}),
        json!({"data": {"translations": [{"translatedText": "a"}]}}),
        json!({"data": {"translations": [
            {"translatedText": "a"}, {"translatedText": "b"}, {"translatedText": "c"}
        ]}}),
        json!({"data": {"translations": [{"translatedText": "a"}, {"translatedText": ""}]}}),
        json!({"data": {"translations": [{"translatedText": "a"}, {"translatedText": " \n"}]}}),
        json!({"data": {"translations": [{"translatedText": "a"}, {"translatedText": "&#32;&nbsp;"}]}}),
        json!({"data": {"translations": [{"translatedText": "a"}, {}]}}),
        json!({}),
    ] {
        let error = decode_google(&response, 2).unwrap_err();
        assert!(error.split_retry);
        assert!(!error.retryable);
    }
}

fn google_request(contents: Vec<String>) -> PoolRequest {
    PoolRequest::Google {
        api_key: "unused-in-unit-tests".into(),
        contents,
    }
}

#[test]
fn google_request_budget_uses_the_actual_serialized_json_byte_size() {
    let overhead = serde_json::to_vec(&google_body(&[String::new()]))
        .unwrap()
        .len();
    let exact = "a".repeat(GOOGLE_SAFE_REQUEST_BYTES - overhead);
    assert_eq!(
        serde_json::to_vec(&google_body(std::slice::from_ref(&exact)))
            .unwrap()
            .len(),
        GOOGLE_SAFE_REQUEST_BYTES
    );
    google_request(vec![exact.clone()]).validate_size().unwrap();
    assert!(
        google_request(vec![format!("{exact}a")])
            .validate_size()
            .is_err()
    );

    let unicode = "译".repeat(GOOGLE_SAFE_REQUEST_BYTES / 3);
    assert!(unicode.chars().count() < GOOGLE_SAFE_REQUEST_BYTES);
    assert!(google_request(vec![unicode]).validate_size().is_err());

    // Quotes consume two JSON bytes each even though they are one Unicode character.
    let escaped = "\"".repeat((GOOGLE_SAFE_REQUEST_BYTES - overhead) / 2);
    google_request(vec![escaped.clone()])
        .validate_size()
        .unwrap();
    assert!(
        google_request(vec![format!("{escaped}\"\"")])
            .validate_size()
            .is_err()
    );
}

#[test]
fn google_request_rejects_empty_or_oversized_segment_arrays() {
    assert!(google_request(Vec::new()).validate_size().is_err());
    google_request(vec!["text".into(); 100])
        .validate_size()
        .unwrap();
    assert!(
        google_request(vec!["text".into(); 101])
            .validate_size()
            .is_err()
    );
}

fn deepseek_request(system: String, user: String, max_tokens: u32) -> PoolRequest {
    PoolRequest::DeepSeek {
        api_key: "unused-in-unit-tests".into(),
        system,
        user,
        thinking: false,
        max_tokens,
        user_id: "unit-test".into(),
        segment_ids: None,
    }
}

#[test]
fn deepseek_request_shares_its_input_and_output_context_budget() {
    let output = 2_048;
    let input_budget = DEEPSEEK_SAFE_CONTEXT_TOKENS - output as usize - 1_024;
    let system = "译".repeat(input_budget / 3);
    let user = "x".repeat(input_budget % 3);
    assert_eq!(system.len() + user.len(), input_budget);
    assert!(system.chars().count() < system.len());
    deepseek_request(system.clone(), user.clone(), output)
        .validate_size()
        .unwrap();
    let input_error = deepseek_request(system.clone(), format!("{user}x"), output)
        .validate_size()
        .unwrap_err();
    assert!(input_error.split_retry);
    assert!(!input_error.retryable);
    assert!(
        deepseek_request(system, user, output + 1)
            .validate_size()
            .is_err()
    );
}

#[test]
fn deepseek_request_bounds_the_output_including_reasoning_tokens() {
    for thinking in [false, true] {
        let mut request =
            deepseek_request("system".into(), "user".into(), DEEPSEEK_SAFE_OUTPUT_TOKENS);
        if let PoolRequest::DeepSeek { thinking: mode, .. } = &mut request {
            *mode = thinking;
        }
        request.validate_size().unwrap();
    }
    for output in [0, DEEPSEEK_SAFE_OUTPUT_TOKENS + 1] {
        assert!(
            deepseek_request("system".into(), "user".into(), output)
                .validate_size()
                .is_err()
        );
    }
}

#[test]
fn deepseek_request_batch_ids_must_be_nonempty_unique_and_bounded() {
    let maximum = crate::settings::DEEPSEEK_MAX_SEGMENTS_PER_REQUEST;
    let mut request = deepseek_request("system".into(), "user".into(), 2_048);
    if let PoolRequest::DeepSeek { segment_ids, .. } = &mut request {
        *segment_ids = Some((0..maximum).collect());
    }
    request.validate_size().unwrap();
    for ids in [Vec::new(), vec![7, 7], (0..=maximum).collect()] {
        if let PoolRequest::DeepSeek { segment_ids, .. } = &mut request {
            *segment_ids = Some(ids);
        }
        assert!(request.validate_size().is_err());
    }
}

#[test]
fn google_403_user_minute_limits_retry_but_daily_quota_and_auth_do_not() {
    for body in [
        r#"{"error":{"message":"User Rate Limit Exceeded"}}"#,
        r#"{"error":{"errors":[{"reason":"userRateLimitExceeded"}]}}"#,
    ] {
        let error = http_error(
            "Google Cloud Translation",
            StatusCode::FORBIDDEN,
            None,
            body,
        );
        assert!(error.retryable);
        assert!(!error.split_retry);
        assert_eq!(error.retry_after, Some(Duration::from_secs(60)));
    }
    for body in [
        r#"{"error":{"message":"Daily Limit Exceeded","errors":[{"reason":"dailyLimitExceeded"}]}}"#,
        r#"{"error":{"message":"API key not valid","status":"PERMISSION_DENIED"}}"#,
        r#"{"error":{"message":"Cloud Translation API has not been used in project or is disabled."}}"#,
    ] {
        let error = http_error(
            "Google Cloud Translation",
            StatusCode::FORBIDDEN,
            None,
            body,
        );
        assert!(!error.retryable);
        assert!(!error.split_retry);
        assert_eq!(error.retry_after, None);
    }
    let deepseek = http_error(
        "DeepSeek",
        StatusCode::FORBIDDEN,
        None,
        "User Rate Limit Exceeded",
    );
    assert!(!deepseek.retryable);
}

#[test]
fn provider_http_errors_distinguish_transient_limits_from_oversized_batches() {
    for status in [429, 500, 502, 503, 504] {
        let error = http_error(
            "DeepSeek",
            StatusCode::from_u16(status).unwrap(),
            Some(Duration::from_secs(7)),
            "temporary error",
        );
        assert!(error.retryable);
        assert!(!error.split_retry);
        assert_eq!(error.retry_after, Some(Duration::from_secs(7)));
    }
    for (status, body) in [
        (StatusCode::PAYLOAD_TOO_LARGE, "request too large"),
        (StatusCode::BAD_REQUEST, "context_length_exceeded"),
        (StatusCode::BAD_REQUEST, "maximum context length exceeded"),
    ] {
        let error = http_error("DeepSeek", status, None, body);
        assert!(!error.retryable);
        assert!(error.split_retry);
    }
    let invalid_key = http_error("DeepSeek", StatusCode::UNAUTHORIZED, None, "invalid key");
    assert!(!invalid_key.retryable);
    assert!(!invalid_key.split_retry);
}

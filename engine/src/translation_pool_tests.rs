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

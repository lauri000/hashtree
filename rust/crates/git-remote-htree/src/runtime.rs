use anyhow::{Context, Result};
use std::future::Future;
use std::time::Duration;
use tokio::runtime::Runtime;

const RUNTIME_SHUTDOWN_TIMEOUT: Duration = Duration::from_millis(500);

pub(crate) fn new_multi_thread_runtime() -> std::io::Result<Runtime> {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
}

pub(crate) fn block_on_result<T, F>(future: F) -> Result<T>
where
    F: Future<Output = Result<T>>,
{
    let runtime = new_multi_thread_runtime().context("Failed to create tokio runtime")?;
    let result = runtime.block_on(future);
    runtime.shutdown_timeout(RUNTIME_SHUTDOWN_TIMEOUT);
    result
}

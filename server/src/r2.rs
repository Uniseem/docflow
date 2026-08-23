use std::path::Path;

use crate::settings::R2Settings;
use anyhow::{Context, Result};
use aws_config::{BehaviorVersion, Region};
use aws_sdk_s3::{
    Client,
    config::{Credentials, SharedCredentialsProvider},
    primitives::ByteStream,
};

pub struct R2Client {
    client: Client,
    pub settings: R2Settings,
}

impl R2Client {
    pub async fn new(settings: R2Settings) -> Self {
        let credentials = Credentials::new(
            settings.access_key_id.clone(),
            settings.secret_access_key.clone(),
            None,
            None,
            "docflow-r2-admin-settings",
        );
        let sdk = aws_config::defaults(BehaviorVersion::latest())
            .region(Region::new("auto"))
            .endpoint_url(format!(
                "https://{}.r2.cloudflarestorage.com",
                settings.account_id
            ))
            .credentials_provider(SharedCredentialsProvider::new(credentials))
            .load()
            .await;
        let config = aws_sdk_s3::config::Builder::from(&sdk)
            .force_path_style(true)
            .build();
        Self {
            client: Client::from_conf(config),
            settings,
        }
    }

    pub async fn validate(&self) -> Result<()> {
        self.client
            .head_bucket()
            .bucket(&self.settings.bucket)
            .send()
            .await
            .map_err(|error| anyhow::anyhow!("无法访问 R2 存储桶：{error}"))?;
        Ok(())
    }

    pub async fn put_file(&self, key: &str, path: &Path, content_type: &str) -> Result<String> {
        let body = ByteStream::from_path(path)
            .await
            .with_context(|| format!("读取待归档文件失败：{}", path.display()))?;
        let result = self
            .client
            .put_object()
            .bucket(&self.settings.bucket)
            .key(key)
            .content_type(content_type)
            .body(body)
            .send()
            .await
            .map_err(|error| anyhow::anyhow!("上传 R2 对象 {key} 失败：{error}"))?;
        self.client
            .head_object()
            .bucket(&self.settings.bucket)
            .key(key)
            .send()
            .await
            .map_err(|error| anyhow::anyhow!("R2 对象 {key} 上传后校验失败：{error}"))?;
        Ok(result.e_tag.unwrap_or_default())
    }

    pub async fn get(
        &self,
        key: &str,
    ) -> Result<aws_sdk_s3::operation::get_object::GetObjectOutput> {
        self.client
            .get_object()
            .bucket(&self.settings.bucket)
            .key(key)
            .send()
            .await
            .map_err(|error| anyhow::anyhow!("读取 R2 对象 {key} 失败：{error}"))
    }
}

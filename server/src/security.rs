use anyhow::{Context, Result};
use argon2::{
    Argon2, PasswordHash, PasswordHasher, PasswordVerifier,
    password_hash::{SaltString, rand_core::OsRng},
};
use axum::{
    extract::Request,
    http::{HeaderMap, header},
    middleware::Next,
    response::Response,
};
use base64::{
    Engine,
    engine::general_purpose::{URL_SAFE, URL_SAFE_NO_PAD},
};
use chrono::{Duration, Utc};
use fernet::Fernet;
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation, decode, encode};
use rand::{RngCore, rngs::OsRng as TokenOsRng};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{api::ApiError, db::AppState};

#[derive(Debug, Serialize, Deserialize)]
struct Claims {
    sub: String,
    username: String,
    iat: usize,
    exp: usize,
}

fn fernet(secret_key: &str) -> Result<Fernet> {
    let digest = Sha256::digest(secret_key.as_bytes());
    let key = URL_SAFE.encode(digest);
    Fernet::new(&key).context("无法创建配置加密器")
}

pub fn encrypt_secret(secret_key: &str, value: &str) -> Result<String> {
    Ok(fernet(secret_key)?.encrypt(value.as_bytes()))
}

pub fn decrypt_secret(secret_key: &str, value: &str) -> Result<String> {
    let bytes = fernet(secret_key)?
        .decrypt(value)
        .context("无法解密配置；SECRET_KEY 可能已更改")?;
    String::from_utf8(bytes).context("配置密文不是 UTF-8")
}

pub fn hash_password(password: &str) -> Result<String> {
    let salt = SaltString::generate(&mut OsRng);
    let encoded = Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map_err(|error| anyhow::anyhow!("管理员密码哈希失败：{error}"))?;
    Ok(encoded.to_string())
}

pub fn verify_password(candidate: &str, encoded: &str) -> bool {
    PasswordHash::new(encoded)
        .ok()
        .and_then(|hash| {
            Argon2::default()
                .verify_password(candidate.as_bytes(), &hash)
                .ok()
        })
        .is_some()
}

pub fn password_hash_is_supported(encoded: &str) -> bool {
    PasswordHash::new(encoded).is_ok()
}

pub fn create_token(secret_key: &str, username: &str) -> Result<String> {
    let now = Utc::now();
    let claims = Claims {
        sub: "admin".into(),
        username: username.into(),
        iat: now.timestamp() as usize,
        exp: (now + Duration::hours(12)).timestamp() as usize,
    };
    Ok(encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(secret_key.as_bytes()),
    )?)
}

pub fn validate_token(secret_key: &str, token: &str) -> bool {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.required_spec_claims = ["exp", "sub"].into_iter().map(String::from).collect();
    decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret_key.as_bytes()),
        &validation,
    )
    .map(|data| data.claims.sub == "admin")
    .unwrap_or(false)
}

pub fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find_map(|(key, value)| (key == name).then(|| value.to_string()))
}

pub fn admin_token(headers: &HeaderMap) -> Option<String> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::to_string)
        .or_else(|| cookie_value(headers, "docflow_admin"))
}

pub fn request_is_admin(secret_key: &str, headers: &HeaderMap) -> bool {
    admin_token(headers).is_some_and(|token| validate_token(secret_key, &token))
}

pub fn create_document_access_token() -> String {
    let mut bytes = [0u8; 32];
    TokenOsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn hash_document_access_token(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

pub fn verify_document_access_token(token: &str, expected_hash: &str) -> bool {
    let candidate = hash_document_access_token(token);
    candidate.len() == expected_hash.len()
        && candidate
            .as_bytes()
            .iter()
            .zip(expected_hash.as_bytes())
            .fold(0u8, |difference, (left, right)| difference | (left ^ right))
            == 0
}

pub async fn require_admin(
    axum::extract::State(state): axum::extract::State<std::sync::Arc<AppState>>,
    request: Request,
    next: Next,
) -> Result<Response, ApiError> {
    if !request_is_admin(&state.config.secret_key, request.headers()) {
        return Err(ApiError::unauthorized("需要有效的管理员登录"));
    }
    Ok(next.run(request).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypted_settings_round_trip() {
        let token = encrypt_secret("a stable instance secret", "sk-sensitive-value").unwrap();
        assert_ne!(token, "sk-sensitive-value");
        assert_eq!(
            decrypt_secret("a stable instance secret", &token).unwrap(),
            "sk-sensitive-value"
        );
        assert!(decrypt_secret("different secret", &token).is_err());
    }

    #[test]
    fn password_hash_uses_argon2_and_verifies() {
        let encoded = hash_password("a sufficiently long password").unwrap();
        assert!(encoded.starts_with("$argon2"));
        assert!(verify_password("a sufficiently long password", &encoded));
        assert!(!verify_password("wrong password", &encoded));
    }

    #[test]
    fn jwt_round_trip_and_rejects_wrong_key() {
        let token = create_token("signing-key", "administrator").unwrap();
        assert!(validate_token("signing-key", &token));
        assert!(!validate_token("another-key", &token));
    }

    #[test]
    fn document_access_tokens_are_random_and_hash_verified() {
        let first = create_document_access_token();
        let second = create_document_access_token();
        assert_ne!(first, second);
        let hash = hash_document_access_token(&first);
        assert!(verify_document_access_token(&first, &hash));
        assert!(!verify_document_access_token(&second, &hash));
    }
}

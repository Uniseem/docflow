from __future__ import annotations

import base64
import hashlib
import hmac
from datetime import datetime, timedelta, timezone

import jwt
from cryptography.fernet import Fernet, InvalidToken
from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pwdlib import PasswordHash

from .config import get_settings


bearer = HTTPBearer(auto_error=False)
password_hash = PasswordHash.recommended()


def _fernet() -> Fernet:
    digest = hashlib.sha256(get_settings().secret_key.encode("utf-8")).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def encrypt_secret(value: str) -> str:
    return _fernet().encrypt(value.encode("utf-8")).decode("ascii")


def decrypt_secret(value: str) -> str:
    try:
        return _fernet().decrypt(value.encode("ascii")).decode("utf-8")
    except InvalidToken as exc:
        raise RuntimeError("无法解密配置；SECRET_KEY 可能已被更改") from exc


def hash_admin_password(password: str) -> str:
    return password_hash.hash(password)


def verify_admin_password(candidate: str, encoded: str) -> bool:
    return password_hash.verify(candidate, encoded)


def usernames_match(candidate: str, stored: str) -> bool:
    return hmac.compare_digest(candidate.encode("utf-8"), stored.encode("utf-8"))


def create_admin_token(username: str) -> str:
    now = datetime.now(timezone.utc)
    return jwt.encode(
        {"sub": "admin", "username": username, "iat": now, "exp": now + timedelta(hours=12)},
        get_settings().secret_key,
        algorithm="HS256",
    )


def require_admin(credentials: HTTPAuthorizationCredentials | None = Depends(bearer)) -> None:
    if credentials is None:
        raise HTTPException(status_code=401, detail="需要管理员登录")
    try:
        payload = jwt.decode(credentials.credentials, get_settings().secret_key, algorithms=["HS256"])
    except jwt.PyJWTError as exc:
        raise HTTPException(status_code=401, detail="登录已过期") from exc
    if payload.get("sub") != "admin":
        raise HTTPException(status_code=403, detail="无管理员权限")

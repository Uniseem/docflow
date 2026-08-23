from sqlalchemy.orm import Session

from .models import AppSetting
from .security import decrypt_secret, encrypt_secret


MINERU_API_KEY = "mineru_api_key"
MINERU_MODEL = "mineru_model"
DEEPSEEK_API_KEY = "deepseek_api_key"
DEEPSEEK_MODEL = "deepseek_model"


def get_value(db: Session, key: str, default: str | None = None) -> str | None:
    item = db.get(AppSetting, key)
    if item is None:
        return default
    return decrypt_secret(item.value) if item.encrypted else item.value


def set_value(db: Session, key: str, value: str, *, secret: bool = False) -> None:
    stored = encrypt_secret(value) if secret else value
    item = db.get(AppSetting, key)
    if item is None:
        item = AppSetting(key=key, value=stored, encrypted=secret)
        db.add(item)
    else:
        item.value = stored
        item.encrypted = secret
    db.commit()


def is_configured(db: Session, key: str) -> bool:
    value = get_value(db, key)
    return bool(value and value.strip())


def mask_secret(value: str | None) -> str | None:
    if not value:
        return None
    suffix = value[-4:] if len(value) >= 4 else value
    return f"••••••••{suffix}"


from app.security import decrypt_secret, encrypt_secret


def test_secret_roundtrip_is_encrypted() -> None:
    raw = "sk-test-secret-value"
    encrypted = encrypt_secret(raw)
    assert raw not in encrypted
    assert decrypt_secret(encrypted) == raw


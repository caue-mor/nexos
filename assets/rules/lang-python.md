---
paths:
  - "**/*.py"
  - "**/*.pyi"
  - "**/pyproject.toml"
---

# Python — NexOS Language Rules

Applies to all `.py` and `.pyi` files in NexOS projects (backends, scripts, AI agents, data pipelines).

---

## 1. Type Hints — Always Required

All function signatures must have complete type annotations. Use `from __future__ import annotations` for forward references.

```python
from __future__ import annotations
from typing import Optional

# WRONG — no type hints
def get_user(user_id):
    return db.query(user_id)

# CORRECT — fully annotated
def get_user(user_id: str) -> Optional[UserProfile]:
    return db.query(user_id)
```

Run `mypy --strict` or `pyright` as part of your quality gate.

---

## 2. Pydantic for Data Models at Boundaries

Use Pydantic v2 for all data models that cross a boundary (API request/response, env vars, config). Use `dataclasses` for purely internal value objects.

```python
from pydantic import BaseModel, EmailStr, field_validator
from pydantic_settings import BaseSettings

# API boundary — Pydantic
class CreateUserRequest(BaseModel):
    name: str
    email: EmailStr
    role: Literal['admin', 'user', 'manager'] = 'user'

    @field_validator('name')
    @classmethod
    def name_must_not_be_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError('Name cannot be blank')
        return v.strip()

# Internal value object — dataclass
from dataclasses import dataclass

@dataclass(frozen=True)
class Coordinate:
    lat: float
    lon: float
```

---

## 3. Env Vars with pydantic-settings

Never read `os.environ` directly. Use `pydantic-settings` for typed, validated config.

```python
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file='.env', extra='forbid')

    database_url: str
    openai_api_key: str
    debug: bool = False
    max_retries: int = 3

settings = Settings()  # Raises ValidationError if required vars are missing
```

---

## 4. Async Patterns

Use `asyncio` and `async`/`await` throughout async codebases. Never mix sync blocking calls inside async functions.

```python
import asyncio
import httpx
from typing import Any

# WRONG — blocking call inside async function
async def fetch_data(url: str) -> dict[str, Any]:
    import requests
    return requests.get(url).json()  # blocks the event loop

# CORRECT — async client
async def fetch_data(url: str) -> dict[str, Any]:
    async with httpx.AsyncClient() as client:
        response = await client.get(url, timeout=30.0)
        response.raise_for_status()
        return response.json()
```

For CPU-bound work inside async code, use `asyncio.to_thread()`:

```python
import asyncio

async def process_large_file(path: str) -> list[str]:
    return await asyncio.to_thread(_read_and_parse, path)

def _read_and_parse(path: str) -> list[str]:
    # CPU-bound sync work here
    ...
```

---

## 5. Error Handling

Catch specific exceptions. Never silence errors with bare `except`. Log with context.

```python
import logging
from typing import Optional

logger = logging.getLogger(__name__)

# WRONG — swallowing exceptions
def get_record(record_id: str) -> Optional[dict]:
    try:
        return db.find(record_id)
    except:
        return None

# CORRECT — specific exception, contextual logging
def get_record(record_id: str) -> Optional[dict]:
    try:
        return db.find(record_id)
    except NotFoundError:
        return None
    except DatabaseError as exc:
        logger.error('db lookup failed', extra={'record_id': record_id, 'error': str(exc)})
        raise
```

---

## 6. pytest Conventions

All tests live in `tests/`. Mirror the `src/` structure. Use descriptive names.

```python
import pytest
from unittest.mock import AsyncMock, patch

# Mark categorizes tests — use consistently
@pytest.mark.unit
def test_coordinate_is_immutable() -> None:
    coord = Coordinate(lat=0.0, lon=0.0)
    with pytest.raises(AttributeError):
        coord.lat = 1.0  # type: ignore[misc]

@pytest.mark.integration
async def test_fetch_user_returns_profile() -> None:
    result = await get_user('user-123')
    assert result is not None
    assert result.email.endswith('@example.com')

# Fixtures in conftest.py — never inline setup/teardown
@pytest.fixture
def mock_db(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr('src.db.query', lambda _: None)
```

Run coverage with:

```bash
pytest --cov=src --cov-report=term-missing --cov-fail-under=80
```

---

## 7. Formatting and Linting

Use these tools — no style debates:

```bash
ruff check . --fix    # linting + import sorting
ruff format .         # formatting (replaces black)
mypy src/             # type checking
```

`pyproject.toml` minimum config:

```toml
[tool.ruff]
line-length = 100
target-version = "py311"

[tool.ruff.lint]
select = ["E", "F", "I", "UP", "B", "SIM"]

[tool.mypy]
strict = true
python_version = "3.11"
```

---

## 8. Virtual Environments

Always work inside a venv. Never install packages globally.

```bash
python -m venv .venv
source .venv/bin/activate   # macOS/Linux
.venv\Scripts\activate      # Windows

pip install -e ".[dev]"
```

Document all dependencies in `pyproject.toml` — never only in `requirements.txt`.

---

## 9. Naming Conventions

| Entity | Convention | Example |
|--------|-----------|---------|
| Modules/files | snake_case | `user_service.py` |
| Classes | PascalCase | `UserService` |
| Functions/methods | snake_case | `get_user_by_id` |
| Constants | SCREAMING_SNAKE | `MAX_RETRY_COUNT` |
| Private members | `_` prefix | `_validate_email` |
| Type aliases | PascalCase | `UserId = str` |

---

## 10. Quality Gates

```bash
ruff check .          # linting — zero errors
ruff format --check . # formatting — zero diffs
mypy src/             # type check — zero errors
pytest                # all tests passing
```

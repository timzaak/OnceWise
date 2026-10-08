"""Herald test environment: real Herald (docker) + Redis for backend integration tests.

Mirrors the rmqtt-things test tooling pattern: one shared PostgreSQL (the demo container,
same one the scenario tests use for TEST_DATABASE_URL) hosts Herald's ``herald_test``
database; Redis and Herald run as dedicated test containers. The Herald image defaults to
``ghcr.io/timzaak/herald:0.6.1`` and can be overridden via the ``HERALD_IMAGE`` env var.

Realm / client app / test users are NOT seeded here — the Rust tests seed them idempotently
directly against Herald's database (see backend/tests/scenario_herald_auth.rs).
"""

from pathlib import Path

from . import docker
from .net import wait_for_http_ok
from .paths import LOG_DIR, ensure_dir

HERALD_CONTAINER = "oncewise-test-herald"
REDIS_CONTAINER = "oncewise-test-redis"

HERALD_PORT = 13001
REDIS_PORT = 16381

HERALD_URL = f"http://127.0.0.1:{HERALD_PORT}"
HERALD_DATABASE_NAME = "herald_test"
HERALD_DATABASE_URL = f"postgres://postgres:postgres@127.0.0.1:5432/{HERALD_DATABASE_NAME}"
HERALD_REDIS_ADDR = f"127.0.0.1:{REDIS_PORT}"

HERALD_IMAGE_DEFAULT = "ghcr.io/timzaak/herald:0.6.1"
REDIS_IMAGE = "redis:8.4-alpine"

# The BFF redirect URI whitelisted in the seeded Herald client app. Nothing ever serves it:
# the tests extract the authorization code from Herald's login response instead of following
# the redirect, and oncewise-ai-sync only exchanges the code server-to-server.
TEST_CALLBACK_URI = "http://127.0.0.1:8099/api/auth/oauth/callback"


def ensure_herald_database(pg_container: str, logger: "Logger") -> bool:  # noqa: F821
    """Create herald_test on the shared demo PostgreSQL (Herald migrates it on boot)."""
    code, out = docker.exec_check(
        pg_container,
        ["psql", "-U", "postgres", "-d", "postgres", "-c", f"CREATE DATABASE {HERALD_DATABASE_NAME}"],
    )
    if code == 0 or "already exists" in out:
        logger.info(f"Herald database ready ({HERALD_DATABASE_NAME})")
        return True
    logger.error(f"Failed to create the Herald database: {out}")
    return False


def _write_herald_config() -> Path:
    """Generate Herald's config.toml (points at the shared host PostgreSQL and test Redis)."""
    conf_dir = ensure_dir(LOG_DIR / "herald-test")
    config = conf_dir / "config.toml"
    config.write_text(
        f"""[database]
url = "postgresql://postgres:postgres@host.docker.internal:5432/{HERALD_DATABASE_NAME}?sslmode=disable"

[redis]
url = "redis://host.docker.internal:{REDIS_PORT}"

[server]
bind_address = "0.0.0.0:3000"
log_level = "warn"
app_env = "test"

[frontend]
url = "http://localhost:{HERALD_PORT}"

[jwt]
secret = "oncewise-herald-test-jwt-secret"

# Required by Herald: startup guard rejects an empty ask_key/cname_target.
[custom_domain]
ask_key = "oncewise-herald-test-custom-domain-ask-key"
cname_target = "custom.test.oncewise.local"
""",
        encoding="utf-8",
    )
    return config


def start_herald(logger: "Logger") -> bool:  # noqa: F821
    docker.rm_force_container(HERALD_CONTAINER)
    docker.rm_force_container(REDIS_CONTAINER)

    logger.info("Starting Redis test container ...")
    if not docker.run_detached(
        [
            "--name", REDIS_CONTAINER,
            "--memory=128m",
            "--log-opt", "max-size=10m",
            "--log-opt", "max-file=3",
            "-p", f"127.0.0.1:{REDIS_PORT}:6379",
            REDIS_IMAGE,
        ]
    ):
        logger.error("Redis test container failed to start")
        return False

    import os

    image = os.environ.get("HERALD_IMAGE", HERALD_IMAGE_DEFAULT)
    logger.info(f"Starting Herald ({image}) ...")
    config = _write_herald_config()
    if not docker.run_detached(
        [
            "--name", HERALD_CONTAINER,
            "--memory=512m",
            "--add-host", "host.docker.internal:host-gateway",
            "--log-opt", "max-size=10m",
            "--log-opt", "max-file=3",
            "-e", "HERALD_CONFIG=/app/config.toml",
            "--mount", f"type=bind,source={str(config.resolve())},target=/app/config.toml,readonly",
            "-p", f"127.0.0.1:{HERALD_PORT}:3000",
            image,
        ]
    ):
        logger.error("Herald test container failed to start")
        return False

    if not wait_for_http_ok(f"{HERALD_URL}/health", 120, logger=logger):
        logger.error(
            f"Herald did not become healthy on {HERALD_URL}/health "
            f"(inspect with: docker logs {HERALD_CONTAINER})"
        )
        return False
    logger.info(f"Herald is ready: {HERALD_URL}")
    return True


def stop_herald(logger: "Logger") -> None:  # noqa: F821
    """Remove the test containers. The shared demo PostgreSQL is left untouched."""
    # `docker rm -f` is idempotent for absent containers — no running-check needed.
    for name, label in ((HERALD_CONTAINER, "Herald"), (REDIS_CONTAINER, "Redis")):
        docker.rm_force_container(name)
        logger.info(f"Removed the {label} test container ({name})")

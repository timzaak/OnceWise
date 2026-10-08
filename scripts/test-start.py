#!/usr/bin/env python
"""Start the Herald integration-test environment (real Herald in docker + Redis).

The backend scenario tests (backend/tests/scenario_herald_auth.rs) talk to this real
Herald instance instead of an HTTP double. Run this before `cargo test`, and
`scripts/test-stop.py` afterwards. The shared demo PostgreSQL (oncewise-demo-pg) is
reused and left running on stop.
"""
import argparse
import sys

from lib import herald_env
from lib.demo_session import DEMO_PG_CONTAINER, ensure_demo_postgres
from lib.logger import Logger, LogLevel


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("-q", "--quiet", action="store_true", help="Errors only")
    args = parser.parse_args()
    logger = Logger(LogLevel.ERROR if args.quiet else LogLevel.NORMAL)

    ensure_demo_postgres(logger)
    if not herald_env.ensure_herald_database(DEMO_PG_CONTAINER, logger):
        return 1
    if not herald_env.start_herald(logger):
        return 1

    logger.info("")
    logger.info("Herald test environment is ready:")
    logger.info(f"  Herald          {herald_env.HERALD_URL}  (image overridable via HERALD_IMAGE)")
    logger.info(f"  Herald database {herald_env.HERALD_DATABASE_URL}")
    logger.info(f"  Redis           {herald_env.HERALD_REDIS_ADDR}")
    logger.info("Run the backend tests with:")
    logger.info("  cd backend && TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres cargo test")
    logger.info("Stop the environment: uv run scripts/test-stop.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())

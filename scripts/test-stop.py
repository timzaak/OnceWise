#!/usr/bin/env python
"""Stop the Herald integration-test environment (removes the Herald + Redis test containers).

The shared demo PostgreSQL and its herald_test database are intentionally left in place.
"""
import argparse
import sys

from lib import herald_env
from lib.logger import Logger, LogLevel


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("-q", "--quiet", action="store_true", help="Errors only")
    args = parser.parse_args()
    logger = Logger(LogLevel.ERROR if args.quiet else LogLevel.NORMAL)
    herald_env.stop_herald(logger)
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python
import argparse
import sys

from lib import demo_session
from lib.logger import Logger, LogLevel


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Stop the oncewise-ai manual demo environment (browser, oncewise-ai-sync, host pages, demo PostgreSQL container)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  uv run scripts/demo-stop.py
  uv run scripts/demo-stop.py -v
        """,
    )

    verbosity_group = parser.add_mutually_exclusive_group()
    verbosity_group.add_argument(
        "-v", "--verbose",
        action="count",
        default=0,
        help="Increase verbosity (-v for verbose, -vv for debug)",
    )
    verbosity_group.add_argument(
        "-q", "--quiet",
        action="store_true",
        help="Quiet mode (errors only)",
    )

    args = parser.parse_args()

    if args.quiet:
        level = LogLevel.QUIET
    elif args.verbose == 1:
        level = LogLevel.VERBOSE
    elif args.verbose >= 2:
        level = LogLevel.DEBUG
    else:
        level = LogLevel.NORMAL

    logger = Logger(level=level)
    stopped = demo_session.stop_demo_session(logger)
    if not args.quiet:
        logger.info("Demo environment stopped" if stopped else "No demo processes to stop")
    return 0


if __name__ == "__main__":
    sys.exit(main())

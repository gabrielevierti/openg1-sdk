#!/usr/bin/env python3
"""Run the suite without pytest.

The tests are written pytest-first — that is what CI uses — but a protocol SDK
should be verifiable on a machine with nothing installed on it, including the
machine of someone who just cloned this to see whether it works. So if pytest
is missing, this stands in for the handful of features the tests actually use:
``raises``, ``mark.parametrize``, ``mark.asyncio``, ``fail`` and ``skip``.

    python3 tests/run_tests.py           # everything
    python3 tests/run_tests.py -k crc    # only matching names
    python3 tests/run_tests.py -v        # one line per test
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import inspect
import pathlib
import sys
import traceback
import types

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))


# ---------------------------------------------------------------------------
# A pytest stand-in, installed only when the real thing is absent
# ---------------------------------------------------------------------------

def _install_stub() -> None:
    try:
        import pytest  # noqa: F401

        return
    except ImportError:
        pass

    stub = types.ModuleType("pytest")

    class Failed(AssertionError):
        pass

    class Skipped(Exception):
        pass

    class _Raises:
        def __init__(self, expected, match=None):
            self.expected = expected
            self.match = match
            self.value = None

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            if exc_type is None:
                raise Failed(f"expected {self.expected.__name__} but nothing was raised")
            if not issubclass(exc_type, self.expected):
                return False
            self.value = exc
            return True

    class _Mark:
        def __getattr__(self, name):
            def decorator(*args, **kwargs):
                # Bare use: @pytest.mark.asyncio
                if len(args) == 1 and not kwargs and callable(args[0]):
                    return args[0]

                def wrap(func):
                    if name == "parametrize":
                        argnames, argvalues = args[0], list(args[1])
                        ids = kwargs.get("ids")
                        existing = getattr(func, "_params", [])
                        func._params = existing + [(argnames, argvalues, ids)]
                    return func

                return wrap

            return decorator

    stub.mark = _Mark()
    stub.raises = _Raises
    stub.fail = lambda msg="": (_ for _ in ()).throw(Failed(msg))
    stub.skip = lambda msg="": (_ for _ in ()).throw(Skipped(msg))
    stub.Failed = Failed
    stub.Skipped = Skipped
    stub.fixture = lambda *a, **k: (a[0] if a and callable(a[0]) else (lambda f: f))
    sys.modules["pytest"] = stub


_install_stub()
import pytest  # noqa: E402


# ---------------------------------------------------------------------------
# Collection and execution
# ---------------------------------------------------------------------------

def _expand(func):
    """Yield (suffix, kwargs) for every parametrised case, or one bare case."""
    params = getattr(func, "_params", None)
    if not params:
        # With the real pytest installed the decorator is pytest's own, and
        # the cases live in ``pytestmark`` rather than in this file's shim.
        params = [
            (mark.args[0], list(mark.args[1]), mark.kwargs.get("ids"))
            for mark in getattr(func, "pytestmark", [])
            if getattr(mark, "name", "") == "parametrize"
        ]
    if not params:
        yield "", {}
        return
    argnames, argvalues, ids = params[0]
    names = [n.strip() for n in argnames.split(",")]
    for index, value in enumerate(argvalues):
        values = value if len(names) > 1 else [value]
        label = ids[index] if ids else str(index)
        yield f"[{label}]", dict(zip(names, values))


def _collect(module):
    for name, obj in sorted(vars(module).items()):
        if name.startswith("test_") and inspect.isfunction(obj):
            for suffix, kwargs in _expand(obj):
                yield f"{module.__name__}::{name}{suffix}", obj, None, kwargs
        elif name.startswith("Test") and inspect.isclass(obj):
            for method_name, method in sorted(vars(obj).items()):
                if not method_name.startswith("test_"):
                    continue
                for suffix, kwargs in _expand(method):
                    yield (
                        f"{module.__name__}::{name}::{method_name}{suffix}",
                        method,
                        obj,
                        kwargs,
                    )


def _run_one(func, cls, kwargs) -> None:
    if cls is None:
        if inspect.iscoroutinefunction(func):
            asyncio.run(func(**kwargs))
        else:
            func(**kwargs)
        return

    # pytest calls setup_method/teardown_method around each test. Supporting
    # them here keeps a test file runnable under both runners, which is the
    # whole point of having this one — a test that only passes under pytest
    # is a test most people will never run.
    instance = cls()
    setup = getattr(instance, "setup_method", None)
    teardown = getattr(instance, "teardown_method", None)
    if setup is not None:
        setup() if not _wants_arg(setup) else setup(func)
    try:
        target = func.__get__(instance, cls)
        if inspect.iscoroutinefunction(func):
            asyncio.run(target(**kwargs))
        else:
            target(**kwargs)
    finally:
        if teardown is not None:
            teardown() if not _wants_arg(teardown) else teardown(func)


def _wants_arg(hook) -> bool:
    """pytest allows setup_method(self, method) as well as setup_method(self)."""
    try:
        return len(inspect.signature(hook).parameters) >= 1
    except (TypeError, ValueError):
        return False


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("-k", dest="filter", default="", help="substring filter on test id")
    ap.add_argument("-v", dest="verbose", action="store_true")
    ap.add_argument("-x", dest="exitfirst", action="store_true")
    args = ap.parse_args()

    modules = []
    for path in sorted(HERE.glob("test_*.py")):
        spec = __import__(f"tests.{path.stem}", fromlist=["*"])
        modules.append(spec)

    passed = failed = skipped = 0
    failures: list[tuple[str, str]] = []

    for module in modules:
        for test_id, func, cls, kwargs in _collect(module):
            if args.filter and args.filter not in test_id:
                continue
            try:
                _run_one(func, cls, kwargs)
            except getattr(pytest, "Skipped", ()) as exc:  # type: ignore[misc]
                skipped += 1
                if args.verbose:
                    print(f"SKIP {test_id}: {exc}")
                continue
            except Exception:
                failed += 1
                failures.append((test_id, traceback.format_exc()))
                print(f"FAIL {test_id}")
                if args.exitfirst:
                    break
                continue
            passed += 1
            if args.verbose:
                print(f"ok   {test_id}")
        if args.exitfirst and failed:
            break

    if failures:
        print("\n" + "=" * 70)
        for test_id, tb in failures:
            print(f"\n--- {test_id} ---\n{tb}")

    print(f"\n{passed} passed, {failed} failed, {skipped} skipped")
    return 1 if failed else 0


if __name__ == "__main__":
    with contextlib.suppress(KeyboardInterrupt):
        raise SystemExit(main())
    raise SystemExit(130)

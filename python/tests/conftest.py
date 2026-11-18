import pytest


def pytest_configure(config):
    config.addinivalue_line("markers", "asyncio: run the test in an event loop")


@pytest.hookimpl(tryfirst=True)
def pytest_pyfunc_call(pyfuncitem):
    """Minimal async support so the suite runs without pytest-asyncio.

    If pytest-asyncio is installed it wins; this only fills the gap.
    """
    import asyncio
    import inspect

    func = pyfuncitem.obj
    if not inspect.iscoroutinefunction(func):
        return None
    kwargs = {k: v for k, v in pyfuncitem.funcargs.items()
              if k in pyfuncitem._fixtureinfo.argnames}
    asyncio.run(func(**kwargs))
    return True

"""Replay protocol/vectors.json against the Python implementation.

The same file is replayed by the C, C++, Java and TypeScript runners, so a
change that passes here and fails there is a real divergence, not a difference
of opinion about the spec.
"""

from __future__ import annotations

import json
import pathlib

import pytest

from openg1 import framing
from openg1._generated import COMMANDS
from openg1.crc import bmp_crc, crc32_xz
from openg1.text import split_utf8

def _find_vectors() -> pathlib.Path:
    """Walk up until protocol/vectors.json turns up.

    The file lives at the repository root, and this test is run from several
    working directories — the runner, pytest, CI — so searching beats a fixed
    number of ``parents``.
    """
    for parent in pathlib.Path(__file__).resolve().parents:
        candidate = parent / "protocol" / "vectors.json"
        if candidate.exists():
            return candidate
    raise FileNotFoundError("protocol/vectors.json not found above this test")


VECTORS = json.loads(
    _find_vectors().read_text()
)["vectors"]


def ids(kind):
    return [v["name"] for v in VECTORS if v["kind"] == kind]


def of(kind):
    return [v for v in VECTORS if v["kind"] == kind]


@pytest.mark.parametrize("v", of("encode"), ids=ids("encode"))
def test_encode(v):
    spec = COMMANDS[v["command"]]
    full = bytes(spec.prefix) + bytes.fromhex(v["body"])
    wire = (
        framing.encode_framed(spec.opcode, v["seq"], full)
        if spec.framed
        else framing.encode_raw(spec.opcode, full)
    )
    assert wire.hex() == v["expect"]


@pytest.mark.parametrize("v", of("decode"), ids=ids("decode"))
def test_decode(v):
    packet = framing.decode(bytes.fromhex(v["input"]))
    assert packet.opcode == v["expect"]["opcode"]
    assert packet.framed == v["expect"]["framed"]
    assert packet.seq == v["expect"]["seq"]
    assert packet.payload.hex() == v["expect"]["payload"]
    assert packet.trailer.hex() == v["expect"]["trailer"]


@pytest.mark.parametrize("v", of("crc"), ids=ids("crc"))
def test_crc(v):
    assert f"{crc32_xz(bytes.fromhex(v['input'])):08x}" == v["expect"]


@pytest.mark.parametrize("v", of("crc_bmp"), ids=ids("crc_bmp"))
def test_crc_bmp(v):
    assert f"{bmp_crc(bytes.fromhex(v['input'])):08x}" == v["expect"]


@pytest.mark.parametrize("v", of("split"), ids=ids("split"))
def test_split(v):
    pieces = split_utf8(bytes.fromhex(v["input"]), v["limit"])
    assert [p.hex() for p in pieces] == v["expect"]

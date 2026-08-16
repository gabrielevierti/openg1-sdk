"""CRC-32 as the G1 bootloader expects it.

Even's docs call this "Crc32Xz". It is the ordinary CRC-32/ISO-HDLC used by
zlib and PNG: reflected, polynomial 0x04C11DB7, init and xorout 0xFFFFFFFF.
The only G1-specific part is that the four storage-address bytes are prepended
to the image data before the checksum is taken, and the result goes on the
wire big endian.
"""

from __future__ import annotations

import zlib

from ._generated import BMP_STORAGE_ADDRESS


def crc32_xz(data: bytes) -> int:
    """Return the unsigned CRC-32 of *data*."""
    return zlib.crc32(data) & 0xFFFFFFFF


def bmp_crc(image: bytes, address: bytes = BMP_STORAGE_ADDRESS) -> int:
    """CRC for a bitmap transfer, address bytes included as the device does."""
    return crc32_xz(bytes(address) + bytes(image))


def crc32_be(value: int) -> bytes:
    return value.to_bytes(4, "big")

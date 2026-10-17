#!/usr/bin/env python3
# Reads a USB-UIRT (IR receiver) and prints one line per remote button press:
# the 6-byte code it reports, as hex (e.g. "4308101444f0").
# The USB-UIRT talks at 312500 baud, which plain stty cannot set, so the
# speed is set with the termios2 ioctl. Used by Remote.mjs.
# Usage: uirt-read.py DEVICE
import fcntl, os, select, struct, sys, termios

TCGETS2, TCSETS2 = 0x802C542A, 0x402C542B  # x86_64
BOTHER, CBAUD = 0o010000, 0o010017
GAP = 0.04  # seconds of quiet that ends one code

fd = os.open(sys.argv[1], os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
buf = bytearray(fcntl.ioctl(fd, TCGETS2, bytes(44)))
cflag = struct.unpack_from('4I', buf, 0)[2]
cflag = (cflag & ~CBAUD) | BOTHER | termios.CS8 | termios.CREAD | termios.CLOCAL
cflag &= ~(termios.PARENB | termios.CSTOPB | termios.CRTSCTS)
struct.pack_into('4I', buf, 0, 0, 0, cflag, 0)  # raw
struct.pack_into('2I', buf, 36, 312500, 312500)
fcntl.ioctl(fd, TCSETS2, bytes(buf))
termios.tcflush(fd, termios.TCIOFLUSH)

burst = b''
while True:
    r, _, _ = select.select([fd], [], [], GAP)
    if r:
        data = os.read(fd, 256)
        if not data:
            sys.exit(1)  # unplugged
        burst += data
    elif burst:
        print(burst.hex(), flush=True)
        burst = b''

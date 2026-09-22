// Native sing-box daemon.StartedService fixture, using the v3.22.0 protobuf contract
// in src/gen/daemon/started_service_pb.ts. This is gRPC-Web + grpc-websockets,
// not Clash REST/JSON. Only the four retained pages' methods are implemented.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const varint = (value) => {
  let n = BigInt(value);
  const bytes = [];
  do {
    bytes.push(Number(n & 127n) | (n > 127n ? 128 : 0));
    n >>= 7n;
  } while (n);
  return Buffer.from(bytes);
};
const uint = (field, value) => Buffer.concat([varint(field * 8), varint(value)]);
const bytes = (field, value) => {
  const data = Buffer.from(value);
  return Buffer.concat([varint(field * 8 + 2), varint(data.length), data]);
};
const message = (...fields) => Buffer.concat(fields);
const frame = (payload, flag = 0) => {
  const header = Buffer.alloc(5);
  header[0] = flag;
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
};
const decode = (data) => {
  let offset = 0;
  const read = () => {
    let value = 0n,
      shift = 0n,
      byte;
    do {
      assert.ok(offset < data.length, 'truncated protobuf varint');
      byte = data[offset++];
      value |= BigInt(byte & 127) << shift;
      shift += 7n;
    } while (byte & 128);
    return Number(value);
  };
  const fields = {};
  while (offset < data.length) {
    const key = read(),
      wire = key & 7,
      field = key >> 3;
    if (wire === 0) fields[field] = read();
    else {
      assert.equal(wire, 2, 'unexpected request protobuf wire type');
      const length = read();
      assert.ok(offset + length <= data.length, 'truncated protobuf field');
      fields[field] = data.subarray(offset, (offset += length)).toString();
    }
  }
  return fields;
};
const decodeFrame = (data) => {
  assert.ok(data.length >= 5);
  assert.equal(data[0], 0);
  assert.equal(data.readUInt32BE(1), data.length - 5);
  return decode(data.subarray(5));
};
const wsFrame = (data, opcode = 2) => {
  const header = Buffer.alloc(data.length < 126 ? 2 : 4);
  header[0] = 0x80 | opcode;
  header[1] = data.length < 126 ? data.length : 126;
  if (data.length >= 126) header.writeUInt16BE(data.length, 2);
  return Buffer.concat([header, data]);
};

export function createSingboxMock(calls, errors, sockets) {
  let selected = 'node-a',
    connectionOpen = true;
  const groupItem = (tag) => message(bytes(1, tag), bytes(2, 'shadowsocks'), uint(3, 1700000000), uint(4, 12));
  const methods = {
    GetVersion: () => message(bytes(1, 'sing-box 1.13.0'), uint(2, 4)),
    GetStartedAt: () => uint(1, Date.now() - 60000),
    GetClashModeStatus: () => message(bytes(1, 'rule'), bytes(1, 'global'), bytes(1, 'direct'), bytes(2, 'rule')),
    GetDefaultLogLevel: () => uint(1, 4),
    SelectOutbound: (fields) => {
      assert.equal(fields[1], 'PROXY');
      assert.equal(fields[2], 'node-b');
      selected = fields[2];
      return Buffer.alloc(0);
    },
    CloseConnection: (fields) => {
      assert.equal(fields[1], 'smoke-connection');
      connectionOpen = false;
      return Buffer.alloc(0);
    },
    CloseAllConnections: () => {
      connectionOpen = false;
      return Buffer.alloc(0);
    },
  };
  const streams = {
    SubscribeGroups: () =>
      bytes(
        1,
        message(
          bytes(1, 'PROXY'),
          bytes(2, 'selector'),
          uint(3, 1),
          bytes(4, selected),
          bytes(6, groupItem('node-a')),
          bytes(6, groupItem('node-b')),
        ),
      ),
    SubscribeOutbounds: () => message(bytes(1, groupItem('node-a')), bytes(1, groupItem('node-b'))),
    SubscribeStatus: () =>
      message(
        uint(1, 10485760),
        uint(2, 42),
        uint(3, 1),
        uint(4, 1),
        uint(5, 1),
        uint(6, 1024),
        uint(7, 2048),
        uint(8, 2048),
        uint(9, 4096),
      ),
    SubscribeLog: () => bytes(1, message(uint(1, 4), bytes(2, 'dashboard-smoke-log'))),
    SubscribeConnections: () => {
      // ConnectionEvents.reset plus a CONNECTION_EVENT_NEW event containing a native Connection.
      const connection = message(
        bytes(1, 'smoke-connection'),
        bytes(2, 'mixed-in'),
        bytes(3, 'mixed'),
        uint(4, 4),
        bytes(5, 'tcp'),
        bytes(6, '192.168.1.2:32100'),
        bytes(7, '203.0.113.1:443'),
        bytes(8, 'smoke.example'),
        bytes(9, 'tls'),
        uint(12, Date.now() - 5000),
        uint(16, 2048),
        uint(17, 4096),
        bytes(18, 'final'),
        bytes(19, selected),
        bytes(20, 'shadowsocks'),
        bytes(21, selected),
        bytes(21, 'PROXY'),
      );
      return message(
        uint(2, 1),
        ...(connectionOpen ? [bytes(1, message(uint(1, 0), bytes(2, 'smoke-connection'), bytes(3, connection)))] : []),
      );
    },
  };
  const methodName = (url) => {
    assert.ok(url.startsWith('/daemon.StartedService/'));
    return url.slice('/daemon.StartedService/'.length);
  };
  return {
    get selected() {
      return selected;
    },
    reopenConnection() {
      connectionOpen = true;
    },
    async http(req, res) {
      try {
        assert.equal(req.method, 'POST');
        assert.equal(req.headers.authorization, 'Bearer smoke-secret');
        assert.match(req.headers['content-type'], /^application\/grpc-web\+proto/);
        const name = methodName(req.url);
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const fields = decodeFrame(Buffer.concat(chunks));
        calls.push({ method: 'POST', path: req.url, fields });
        assert.ok(Object.hasOwn(methods, name), `unimplemented native RPC: ${name}`);
        const response = methods[name](fields);
        res.writeHead(200, { 'Content-Type': 'application/grpc-web+proto' });
        res.end(message(frame(response), frame(Buffer.from('grpc-status: 0\r\n'), 128)));
      } catch (error) {
        errors.push(String(error));
        res.writeHead(200, { 'Content-Type': 'application/grpc-web+proto' });
        res.end(frame(Buffer.from('grpc-status: 13\r\n'), 128));
      }
    },
    upgrade(req, socket, head) {
      let timer,
        buffer = head || Buffer.alloc(0),
        authorized = false,
        requested = false;
      const name = methodName(req.url);
      sockets.add(socket);
      const fail = (error) => {
        errors.push(String(error));
        socket.destroy();
      };
      socket.on('error', () => {});
      socket.on('close', () => {
        clearInterval(timer);
        sockets.delete(socket);
      });
      try {
        assert.equal(req.headers['sec-websocket-protocol'], 'grpc-websockets');
        assert.ok(Object.hasOwn(streams, name), `unimplemented native stream: ${name}`);
        const accept = createHash('sha1')
          .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
          .digest('base64');
        socket.write(
          `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: grpc-websockets\r\n\r\n`,
        );
      } catch (error) {
        fail(error);
        return;
      }
      const receive = (payload) => {
        if (!authorized) {
          assert.match(payload.toString(), /authorization: Bearer smoke-secret\r\n/);
          authorized = true;
        } else if (payload[0] === 0) {
          const fields = decodeFrame(payload.subarray(1));
          if (name === 'SubscribeStatus' || name === 'SubscribeConnections') assert.equal(fields[1], 1000000000);
          calls.push({ method: 'STREAM', path: req.url, fields });
          requested = true;
        } else {
          assert.deepEqual(payload, Buffer.from([1]));
          assert.ok(requested);
          assert.equal(timer, undefined, 'duplicate stream start');
          const send = () => socket.write(wsFrame(frame(streams[name]())));
          socket.write(wsFrame(frame(Buffer.from('content-type: application/grpc-web+proto\r\n'), 128)));
          send();
          timer = setInterval(send, 250);
        }
      };
      const drain = () => {
        try {
          while (buffer.length >= 2) {
            const opcode = buffer[0] & 15;
            assert.ok(buffer[0] & 128, 'fragmented test WebSocket frame');
            assert.ok(buffer[1] & 128, 'client frame must be masked');
            let length = buffer[1] & 127,
              offset = 2;
            if (length === 126) {
              if (buffer.length < 4) return;
              length = buffer.readUInt16BE(2);
              offset = 4;
            }
            assert.notEqual(length, 127, 'oversized test WebSocket frame');
            if (buffer.length < offset + 4 + length) return;
            const mask = buffer.subarray(offset, offset + 4);
            const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
            for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
            buffer = buffer.subarray(offset + 4 + length);
            if (opcode === 8) {
              socket.end(wsFrame(payload, 8));
              return;
            }
            if (opcode === 9) {
              socket.write(wsFrame(payload, 10));
              continue;
            }
            assert.equal(opcode, 2);
            receive(payload);
          }
        } catch (error) {
          fail(error);
        }
      };
      socket.on('data', (data) => {
        buffer = Buffer.concat([buffer, data]);
        drain();
      });
      drain();
    },
  };
}

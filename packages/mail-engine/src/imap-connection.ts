import net from 'node:net';
import tls from 'node:tls';

export type ImapSecurity = 'tls' | 'starttls' | 'none';

export interface ImapConnectOptions {
  host: string;
  port: number;
  security: ImapSecurity;
  /** Verify the server certificate (disable only for self-signed development setups). */
  rejectUnauthorized?: boolean;
  timeoutMs?: number;
}

export interface ImapResponse {
  status: 'OK' | 'NO' | 'BAD';
  /** Text after the status, including any response code such as "[NONEXISTENT]". */
  text: string;
  /** Untagged response lines ("* ..."), without the leading "* ". */
  untagged: string[];
}

export class ImapProtocolError extends Error {
  constructor(
    message: string,
    readonly response?: ImapResponse,
  ) {
    super(message);
    this.name = 'ImapProtocolError';
  }
}

/** Quotes a string as an IMAP quoted-string. Only printable ASCII is allowed. */
export function quote(value: string): string {
  if (!/^[\x20-\x7e]*$/.test(value)) {
    throw new ImapProtocolError('Only printable ASCII can be sent as an IMAP quoted string');
  }
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * A minimal IMAP client for administrative commands (CREATE, DELETE, SETQUOTA…).
 * It handles tagged/untagged responses and server literals, which is all the
 * admin operations need. It is not a general-purpose mail client.
 */
export class ImapConnection {
  private buffer = Buffer.alloc(0);
  private waiters: Array<() => void> = [];
  private closed = false;
  private failure: Error | null = null;
  private tagCounter = 0;

  private constructor(
    private socket: net.Socket | tls.TLSSocket,
    private readonly timeoutMs: number,
  ) {
    this.attach(socket);
  }

  static async connect(options: ImapConnectOptions): Promise<ImapConnection> {
    const timeoutMs = options.timeoutMs ?? 10_000;
    const tlsOptions = {
      servername: net.isIP(options.host) ? undefined : options.host,
      rejectUnauthorized: options.rejectUnauthorized ?? true,
    };

    const socket = await new Promise<net.Socket | tls.TLSSocket>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      const s =
        options.security === 'tls'
          ? tls.connect({ host: options.host, port: options.port, ...tlsOptions }, () => resolve(s))
          : net.connect({ host: options.host, port: options.port }, () => resolve(s));
      s.once('error', onError);
      s.setTimeout(timeoutMs, () => s.destroy(new Error('IMAP connection timed out')));
    });

    const connection = new ImapConnection(socket, timeoutMs);
    const greeting = await connection.readLine();
    if (!/^\* (OK|PREAUTH)\b/i.test(greeting)) {
      connection.destroy();
      throw new ImapProtocolError(`Unexpected IMAP greeting: ${greeting}`);
    }

    if (options.security === 'starttls') {
      const response = await connection.command('STARTTLS');
      if (response.status !== 'OK') {
        connection.destroy();
        throw new ImapProtocolError('Server refused STARTTLS', response);
      }
      await connection.upgrade(options.host, tlsOptions);
    }
    return connection;
  }

  private attach(socket: net.Socket | tls.TLSSocket): void {
    socket.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.wake();
    });
    socket.on('error', (error) => {
      this.failure = error;
      this.wake();
    });
    socket.on('close', () => {
      this.closed = true;
      this.wake();
    });
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }

  private async upgrade(
    host: string,
    tlsOptions: { servername: string | undefined; rejectUnauthorized: boolean },
  ): Promise<void> {
    const plain = this.socket;
    plain.removeAllListeners('data');
    plain.removeAllListeners('error');
    plain.removeAllListeners('close');
    this.socket = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const secure = tls.connect({ socket: plain, host, ...tlsOptions }, () => resolve(secure));
      secure.once('error', reject);
    });
    this.socket.setTimeout(this.timeoutMs, () => this.socket.destroy(new Error('IMAP connection timed out')));
    this.attach(this.socket);
  }

  private async waitForData(): Promise<void> {
    if (this.failure) throw this.failure;
    if (this.closed) throw new ImapProtocolError('IMAP connection closed');
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    if (this.failure) throw this.failure;
  }

  /** Reads one logical line, inlining any server literals ("{n}\r\n<n bytes>"). */
  private async readLine(): Promise<string> {
    let line = '';
    for (;;) {
      const end = this.buffer.indexOf('\r\n');
      if (end === -1) {
        if (this.closed) throw new ImapProtocolError('IMAP connection closed');
        await this.waitForData();
        continue;
      }
      const part = this.buffer.subarray(0, end).toString('utf8');
      this.buffer = this.buffer.subarray(end + 2);

      const literal = /\{(\d+)\}$/.exec(part);
      if (!literal) return line + part;
      line += part.slice(0, literal.index);
      const size = Number(literal[1]);
      while (this.buffer.length < size) await this.waitForData();
      line += this.buffer.subarray(0, size).toString('utf8');
      this.buffer = this.buffer.subarray(size);
    }
  }

  /** Sends a command and collects responses until its tagged completion. */
  async command(command: string): Promise<ImapResponse> {
    if (/[\r\n\0]/.test(command)) throw new ImapProtocolError('Invalid characters in IMAP command');
    const tag = `A${(++this.tagCounter).toString().padStart(4, '0')}`;
    this.socket.write(`${tag} ${command}\r\n`);

    const untagged: string[] = [];
    for (;;) {
      const line = await this.readLine();
      if (line.startsWith('* ')) {
        untagged.push(line.slice(2));
        continue;
      }
      if (line.startsWith('+')) {
        throw new ImapProtocolError(`Unexpected continuation request for: ${command.split(' ')[0]}`);
      }
      const match = new RegExp(`^${tag} (OK|NO|BAD)\\b ?(.*)$`, 'i').exec(line);
      if (match) {
        return {
          status: match[1]!.toUpperCase() as ImapResponse['status'],
          text: match[2] ?? '',
          untagged,
        };
      }
    }
  }

  /** Like command(), but throws unless the server answers OK. */
  async expectOk(command: string): Promise<ImapResponse> {
    const response = await this.command(command);
    if (response.status !== 'OK') {
      const verb = command.split(' ')[0];
      throw new ImapProtocolError(`${verb} failed: ${response.status} ${response.text}`, response);
    }
    return response;
  }

  async login(user: string, password: string): Promise<void> {
    await this.expectOk(`LOGIN ${quote(user)} ${quote(password)}`);
  }

  async logout(): Promise<void> {
    if (this.closed) return;
    try {
      await this.command('LOGOUT');
    } catch {
      // The server may close the connection before we read its reply.
    } finally {
      this.destroy();
    }
  }

  destroy(): void {
    this.socket.destroy();
  }
}

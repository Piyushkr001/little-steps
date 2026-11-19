import net from "node:net";

export const MAX_SCAN_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_CLAMAV_RESPONSE_BYTES = 4096;

export type MalwareScanStatus =
  | "PENDING"
  | "SCANNING"
  | "CLEAN"
  | "INFECTED"
  | "ERROR";

export interface MalwareScanOutcome {
  status: "CLEAN" | "INFECTED" | "PENDING" | "ERROR";
  provider: string;
  resultMessage: string;
  scannedAt: Date | null;
  configured: boolean;
}

export type MalwareScannerAdapter = (
  buffer: Buffer,
  context: { documentId: string; mimeType: string; checksumSha256?: string }
) => Promise<MalwareScanOutcome>;

export interface ClamAvValidationResult {
  configured: boolean;
  valid: boolean;
  host?: string;
  port?: number;
  timeoutMs?: number;
  reason?: string;
}

let testScannerOverride: MalwareScannerAdapter | null = null;

/**
 * Controlled scanner injection for isolated automated tests only.
 * Strictly prohibited in production environments.
 */
export function setDocumentScannerForTests(
  scanner: MalwareScannerAdapter | null
): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "Malware scanner test override is prohibited in production."
    );
  }
  testScannerOverride = scanner;
}

/**
 * Validates ClamAV host, port, and timeout configuration without exposing
 * sensitive internal hostnames or network addresses in operational errors.
 */
export function validateClamAvConfiguration(
  env: NodeJS.ProcessEnv = process.env
): ClamAvValidationResult {
  const rawHost = env.CLAMAV_HOST?.trim();
  const rawPort = env.CLAMAV_PORT?.trim();
  const rawTimeout = env.CLAMAV_TIMEOUT_MS?.trim();

  if (!rawHost) {
    return {
      configured: false,
      valid: false,
      reason:
        "ClamAV malware scanning service (CLAMAV_HOST) is not configured.",
    };
  }

  // Reject scheme prefixes, whitespace, control characters, or path separators
  if (
    /[\s/\\:@]/.test(rawHost) ||
    rawHost.length > 253 ||
    !/^[a-zA-Z0-9._-]+$/.test(rawHost)
  ) {
    return {
      configured: true,
      valid: false,
      reason: "Configured CLAMAV_HOST is not a valid hostname or IP address.",
    };
  }

  const port = rawPort ? Number(rawPort) : 3310;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return {
      configured: true,
      valid: false,
      reason: "Configured CLAMAV_PORT must be an integer between 1 and 65535.",
    };
  }

  const timeoutMs = rawTimeout ? Number(rawTimeout) : 15_000;
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 1000 ||
    timeoutMs > 120_000
  ) {
    return {
      configured: true,
      valid: false,
      reason:
        "Configured CLAMAV_TIMEOUT_MS must be between 1000 and 120000 ms.",
    };
  }

  return {
    configured: true,
    valid: true,
    host: rawHost,
    port,
    timeoutMs,
  };
}

export function isMalwareScannerConfigured(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (testScannerOverride && env.NODE_ENV !== "production") {
    return true;
  }
  const validation = validateClamAvConfiguration(env);
  return validation.configured && validation.valid;
}

function sanitizeClamAvResponseForStorage(rawResponse: string): string {
  const cleaned = rawResponse
    .replace(/\0/g, "")
    .replace(/[\r\n]+/g, " ")
    .trim();
  if (!cleaned) return "Empty response from malware scanner.";
  // Strip any accidental IPv4/host:port details while retaining signature verdict
  return cleaned
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, "[scanner]")
    .slice(0, 240);
}

/**
 * Streams bytes cleanly to a configured ClamAV `clamd` TCP daemon via the
 * standard `zINSTREAM\0` protocol without ever trusting client headers.
 */
export async function scanBufferWithClamAv(
  buffer: Buffer,
  options: { host: string; port: number; timeoutMs?: number }
): Promise<MalwareScanOutcome> {
  if (!Buffer.isBuffer(buffer) || buffer.byteLength === 0) {
    return {
      status: "ERROR",
      provider: "CLAMAV",
      resultMessage: "Cannot scan empty document payload.",
      scannedAt: new Date(),
      configured: true,
    };
  }

  if (buffer.byteLength > MAX_SCAN_SIZE_BYTES) {
    return {
      status: "ERROR",
      provider: "CLAMAV",
      resultMessage:
        "Document exceeds the 10 MB malware scanning size limit.",
      scannedAt: new Date(),
      configured: true,
    };
  }

  if (
    !options.host ||
    /[\s/\\:@]/.test(options.host) ||
    !Number.isInteger(options.port) ||
    options.port < 1 ||
    options.port > 65535
  ) {
    return {
      status: "ERROR",
      provider: "CLAMAV",
      resultMessage: "Malware scanner network configuration is invalid.",
      scannedAt: new Date(),
      configured: true,
    };
  }

  const timeoutMs = options.timeoutMs ?? 15_000;

  return new Promise<MalwareScanOutcome>((resolve) => {
    const socket = net.createConnection({
      host: options.host,
      port: options.port,
    });
    const chunks: Buffer[] = [];
    let totalResponseBytes = 0;
    let settled = false;

    const finish = (outcome: MalwareScanOutcome) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(outcome);
    };

    socket.setTimeout(timeoutMs);

    socket.on("timeout", () => {
      finish({
        status: "ERROR",
        provider: "CLAMAV",
        resultMessage: "Malware scan timed out waiting for scanner response.",
        scannedAt: new Date(),
        configured: true,
      });
    });

    socket.on("error", (err) => {
      const code = (err as NodeJS.ErrnoException)?.code;
      const safeDetail =
        code === "ECONNREFUSED"
          ? "Malware scanner connection refused."
          : code === "ENOTFOUND"
            ? "Malware scanner service host could not be resolved."
            : "Malware scanner connection error.";
      finish({
        status: "ERROR",
        provider: "CLAMAV",
        resultMessage: safeDetail,
        scannedAt: new Date(),
        configured: true,
      });
    });

    socket.on("connect", () => {
      socket.write("zINSTREAM\0");
      const chunkSize = 64 * 1024;
      for (let offset = 0; offset < buffer.byteLength; offset += chunkSize) {
        const slice = buffer.subarray(
          offset,
          Math.min(offset + chunkSize, buffer.byteLength)
        );
        const lengthPrefix = Buffer.allocUnsafe(4);
        lengthPrefix.writeUInt32BE(slice.byteLength, 0);
        socket.write(lengthPrefix);
        socket.write(slice);
      }
      const zeroTerm = Buffer.alloc(4, 0);
      socket.write(zeroTerm);
    });

    socket.on("data", (data) => {
      totalResponseBytes += data.byteLength;
      if (totalResponseBytes > MAX_CLAMAV_RESPONSE_BYTES) {
        finish({
          status: "ERROR",
          provider: "CLAMAV",
          resultMessage: "Malware scanner returned an oversized invalid response.",
          scannedAt: new Date(),
          configured: true,
        });
        return;
      }
      chunks.push(data);
    });

    const handleComplete = () => {
      if (settled) return;
      const rawText = Buffer.concat(chunks)
        .toString("utf8")
        .replace(/\0/g, "")
        .trim();
      const now = new Date();

      if (/^stream:\s*OK$/i.test(rawText)) {
        finish({
          status: "CLEAN",
          provider: "CLAMAV",
          resultMessage: "stream: OK",
          scannedAt: now,
          configured: true,
        });
        return;
      }

      if (/^stream:\s*.+\s+FOUND$/i.test(rawText)) {
        finish({
          status: "INFECTED",
          provider: "CLAMAV",
          resultMessage: sanitizeClamAvResponseForStorage(rawText),
          scannedAt: now,
          configured: true,
        });
        return;
      }

      finish({
        status: "ERROR",
        provider: "CLAMAV",
        resultMessage: rawText
          ? `Unexpected malware scanner response: ${sanitizeClamAvResponseForStorage(rawText)}`
          : "Malware scanner closed the connection without returning a verdict.",
        scannedAt: now,
        configured: true,
      });
    };

    socket.on("end", handleComplete);
    socket.on("close", () => {
      if (!settled) {
        handleComplete();
      }
    });
  });
}

/**
 * Executes trusted backend malware scanning against uploaded document bytes.
 * Never fabricates CLEAN results when no scanning backend is configured.
 */
export async function scanDocumentBuffer(
  buffer: Buffer,
  context: { documentId: string; mimeType: string; checksumSha256?: string }
): Promise<MalwareScanOutcome> {
  if (testScannerOverride && process.env.NODE_ENV !== "production") {
    return testScannerOverride(buffer, context);
  }

  const config = validateClamAvConfiguration();
  if (!config.configured) {
    return {
      status: "PENDING",
      provider: "UNCONFIGURED",
      resultMessage:
        "Malware scanning service is not configured; document remains PENDING scan.",
      scannedAt: null,
      configured: false,
    };
  }

  if (!config.valid || !config.host || !config.port) {
    return {
      status: "ERROR",
      provider: "CLAMAV",
      resultMessage:
        config.reason || "Malware scanner configuration is invalid.",
      scannedAt: new Date(),
      configured: true,
    };
  }

  return scanBufferWithClamAv(buffer, {
    host: config.host,
    port: config.port,
    timeoutMs: config.timeoutMs,
  });
}

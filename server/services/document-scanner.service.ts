import net from "node:net";

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
  context: { documentId: string; mimeType: string }
) => Promise<MalwareScanOutcome>;

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

export function isMalwareScannerConfigured(): boolean {
  if (testScannerOverride && process.env.NODE_ENV !== "production") {
    return true;
  }
  return Boolean(process.env.CLAMAV_HOST?.trim());
}

/**
 * Streams bytes cleanly to a configured ClamAV `clamd` TCP daemon via the
 * standard `zINSTREAM\0` protocol without ever trusting client headers.
 */
export async function scanBufferWithClamAv(
  buffer: Buffer,
  options: { host: string; port: number; timeoutMs?: number }
): Promise<MalwareScanOutcome> {
  const timeoutMs = options.timeoutMs ?? 15_000;

  return new Promise<MalwareScanOutcome>((resolve) => {
    const socket = net.createConnection({
      host: options.host,
      port: options.port,
    });
    const chunks: Buffer[] = [];
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
        resultMessage: "ClamAV malware scan timed out.",
        scannedAt: new Date(),
        configured: true,
      });
    });

    socket.on("error", (err) => {
      finish({
        status: "ERROR",
        provider: "CLAMAV",
        resultMessage: `ClamAV connection error: ${err.message}`,
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
      chunks.push(data);
    });

    socket.on("end", () => {
      const responseText = Buffer.concat(chunks)
        .toString("utf8")
        .replace(/\0/g, "")
        .trim();
      const now = new Date();

      if (/^stream:\s*OK$/i.test(responseText)) {
        finish({
          status: "CLEAN",
          provider: "CLAMAV",
          resultMessage: responseText,
          scannedAt: now,
          configured: true,
        });
        return;
      }

      if (/FOUND$/i.test(responseText)) {
        finish({
          status: "INFECTED",
          provider: "CLAMAV",
          resultMessage: responseText,
          scannedAt: now,
          configured: true,
        });
        return;
      }

      finish({
        status: "ERROR",
        provider: "CLAMAV",
        resultMessage: responseText || "Unexpected ClamAV response.",
        scannedAt: now,
        configured: true,
      });
    });
  });
}

/**
 * Executes trusted backend malware scanning against uploaded document bytes.
 * Never fabricates CLEAN results when no scanning backend is configured.
 */
export async function scanDocumentBuffer(
  buffer: Buffer,
  context: { documentId: string; mimeType: string }
): Promise<MalwareScanOutcome> {
  if (testScannerOverride && process.env.NODE_ENV !== "production") {
    return testScannerOverride(buffer, context);
  }

  const clamHost = process.env.CLAMAV_HOST?.trim();
  const clamPort = Number(process.env.CLAMAV_PORT || 3310);

  if (clamHost) {
    return scanBufferWithClamAv(buffer, { host: clamHost, port: clamPort });
  }

  return {
    status: "PENDING",
    provider: "UNCONFIGURED",
    resultMessage:
      "Malware scanning service (CLAMAV_HOST / CLAMAV_PORT) is not configured; document remains PENDING scan.",
    scannedAt: null,
    configured: false,
  };
}

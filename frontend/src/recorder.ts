/** Microphone capture via MediaRecorder. Audio stays in memory and is sent only to the local backend. */
export class MicRecorder {
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private stream: MediaStream | null = null;

  static supported(): boolean {
    return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined";
  }

  async start(): Promise<void> {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (e) {
      const name = (e as Error).name;
      if (name === "NotAllowedError") throw new Error("Microphone permission was denied. Allow it in Chrome's address-bar site settings and try again.");
      if (name === "NotFoundError") throw new Error("No microphone was found.");
      throw new Error(`Could not open the microphone (${name}).`);
    }
    this.chunks = [];
    const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((m) => MediaRecorder.isTypeSupported(m));
    this.rec = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    this.rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.rec.start();
  }

  stop(): Promise<Blob> {
    return new Promise((resolve, reject) => {
      const rec = this.rec;
      if (!rec) return reject(new Error("Not recording."));
      rec.onstop = () => {
        this.stream?.getTracks().forEach((t) => t.stop());
        this.stream = null; this.rec = null;
        resolve(new Blob(this.chunks, { type: rec.mimeType || "audio/webm" }));
        this.chunks = [];
      };
      rec.stop();
    });
  }

  cancel() {
    if (this.rec && this.rec.state !== "inactive") { this.rec.onstop = null; this.rec.stop(); }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null; this.rec = null; this.chunks = [];
  }
}

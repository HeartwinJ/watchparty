import { describe, expect, it } from "vitest";
import { assertPublicUrl, isPrivateIP } from "./ssrf.ts";

describe("isPrivateIP", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "::",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
  ])("blocks %s", (ip) => {
    expect(isPrivateIP(ip)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"])(
    "allows %s",
    (ip) => {
      expect(isPrivateIP(ip)).toBe(false);
    },
  );

  it("fails closed for non-IP input", () => {
    expect(isPrivateIP("not-an-ip")).toBe(true);
  });
});

describe("assertPublicUrl", () => {
  it("accepts public http(s) URLs", () => {
    expect(assertPublicUrl("https://example.com/video.mp4").hostname).toBe(
      "example.com",
    );
  });

  it.each([
    "file:///etc/passwd",
    "ftp://example.com/x",
    "http://localhost:8080/",
    "http://foo.localhost/",
    "http://127.0.0.1/",
    "http://[::1]/",
    "http://169.254.169.254/latest/meta-data",
  ])("rejects %s", (url) => {
    expect(() => assertPublicUrl(url)).toThrow();
  });
});

import { describe, expect, it } from "vitest";

import { ipPrefixKey } from "./ip.server.js";

describe("ipPrefixKey — IPv4", () => {
  it("extracts /24 from a plain dotted quad", () => {
    expect(ipPrefixKey("192.168.1.100")).toEqual({
      key: "192.168.1",
      tag: "ip_v4_24",
    });
  });

  it("trims whitespace", () => {
    expect(ipPrefixKey("  10.0.0.5  ")).toEqual({
      key: "10.0.0",
      tag: "ip_v4_24",
    });
  });

  it("rejects octets out of range", () => {
    expect(ipPrefixKey("999.0.0.1")).toBeNull();
    expect(ipPrefixKey("10.0.0.256")).toBeNull();
  });

  it("rejects malformed input", () => {
    expect(ipPrefixKey("1.2.3")).toBeNull();
    expect(ipPrefixKey("a.b.c.d")).toBeNull();
    expect(ipPrefixKey("")).toBeNull();
    expect(ipPrefixKey(null)).toBeNull();
    expect(ipPrefixKey(undefined)).toBeNull();
  });
});

describe("ipPrefixKey — IPv6", () => {
  it("extracts /48 from a full 8-hextet address", () => {
    expect(
      ipPrefixKey("2402:0800:63a2:be1c:1234:5678:9abc:def0"),
    ).toEqual({
      key: "2402:800:63a2",
      tag: "ip_v6_48",
    });
  });

  it("expands :: shorthand", () => {
    expect(ipPrefixKey("2402:800:63a2::1")).toEqual({
      key: "2402:800:63a2",
      tag: "ip_v6_48",
    });
  });

  it("expands leading :: (loopback family)", () => {
    expect(ipPrefixKey("::1")).toEqual({ key: "0:0:0", tag: "ip_v6_48" });
  });

  it("lowercases hex digits", () => {
    expect(ipPrefixKey("2402:800:63A2:BE1C::")?.key).toBe("2402:800:63a2");
  });

  it("strips zone identifiers", () => {
    expect(ipPrefixKey("fe80::1%eth0")).toEqual({
      key: "fe80:0:0",
      tag: "ip_v6_48",
    });
  });

  it("rejects multiple ::", () => {
    expect(ipPrefixKey("1::2::3")).toBeNull();
  });

  it("rejects invalid hextets", () => {
    expect(ipPrefixKey("zzzz::1")).toBeNull();
    expect(ipPrefixKey("12345::1")).toBeNull();
  });
});

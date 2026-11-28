import type { NetworkInterfaceInfoIPv4 } from "node:os";
import { describe, expect, it } from "vitest";

import {
  companionEndpointCandidates,
  extraCompanionUrls,
  hostedCompanionUrl,
  MAX_COMPANION_ENDPOINTS,
} from "../src/endpoints.ts";
import { lanAddresses } from "../src/listener.ts";

describe("hostedCompanionUrl", () => {
  it("normalizes one explicit HTTPS origin", () => {
    expect(hostedCompanionUrl("  https://Maus.Example/  ")).toBe("https://maus.example");
    expect(hostedCompanionUrl(undefined)).toBeNull();
    expect(hostedCompanionUrl("  ")).toBeNull();
  });

  it("refuses insecure or ambiguous hosted routes", () => {
    for (const value of [
      "http://maus.example",
      "https://user:secret@maus.example",
      "https://maus.example/companion",
      "https://maus.example?device=one",
      "https://maus.example#pair",
      "not a URL",
    ]) {
      expect(() => hostedCompanionUrl(value)).toThrow(/OMB_COMPANION_HOSTED_URL/);
    }
  });
});

describe("extraCompanionUrls", () => {
  it("reads custom HTTPS origins separated by commas or newlines", () => {
    expect(extraCompanionUrls(" https://relay.example ,\nhttps://relay2.example:8443\n")).toEqual([
      "https://relay.example",
      "https://relay2.example:8443",
    ]);
    expect(extraCompanionUrls(undefined)).toEqual([]);
    expect(extraCompanionUrls(" , \n")).toEqual([]);
  });

  it("normalizes, dedupes and caps the list", () => {
    expect(extraCompanionUrls("https://Relay.Example/ , https://relay.example")).toEqual(["https://relay.example"]);
    const many = Array.from({ length: 10 }, (_, index) => `https://r${index}.example`).join(",");
    expect(extraCompanionUrls(many)).toHaveLength(MAX_COMPANION_ENDPOINTS);
  });

  it("refuses insecure or ambiguous origins, naming the variable", () => {
    for (const value of [
      "http://relay.example",
      "https://user:secret@relay.example",
      "https://relay.example/companion",
      "https://relay.example?device=one",
      "https://relay.example#pair",
      "not a URL",
    ]) {
      expect(() => extraCompanionUrls(value)).toThrow(/OMB_COMPANION_EXTRA_URL/);
    }
  });
});

describe("companionEndpointCandidates", () => {
  it("puts hosted HTTPS first, followed by tailnet, LAN, and Bonjour routes", () => {
    expect(
      companionEndpointCandidates(
        8810,
        ["100.121.5.6", "192.168.1.42", "10.0.0.7"],
        "macbook.tail1234.ts.net",
        "https://device-123.companion.example",
        "openmausbot-abcd1234.local",
      ),
    ).toEqual([
      { url: "https://device-123.companion.example", kind: "hosted", priority: 0 },
      { url: "http://macbook.tail1234.ts.net:8810", kind: "tailnet", priority: 100 },
      { url: "http://192.168.1.42:8810", kind: "lan", priority: 201 },
      { url: "http://10.0.0.7:8810", kind: "lan", priority: 202 },
      { url: "http://openmausbot-abcd1234.local:8810", kind: "bonjour", priority: 300 },
    ]);
  });

  it("leads a Windows PC's LAN routes with its Wi-Fi address, not WSL's", () => {
    const ipv4 = (address: string, netmask = "255.255.255.0"): NetworkInterfaceInfoIPv4 => ({
      address, netmask, family: "IPv4", mac: "00:15:5d:00:00:01", internal: false, cidr: `${address}/24`,
    });
    const windows = lanAddresses({
      "vEthernet (WSL (Hyper-V firewall))": [ipv4("172.19.96.1", "255.255.240.0")],
      "Wi-Fi": [ipv4("192.168.1.34")],
    });
    const lan = companionEndpointCandidates(8810, windows, null, null, "miguel.local")
      .filter((endpoint) => endpoint.kind === "lan");
    expect(lan.map((endpoint) => endpoint.url)).toEqual(["http://192.168.1.34:8810", "http://172.19.96.1:8810"]);
  });

  it("keeps direct routes when no hosted route exists", () => {
    expect(
      companionEndpointCandidates(8810, ["192.168.1.42"], null, null, "openmausbot-abcd1234.local"),
    ).toEqual([
      { url: "http://192.168.1.42:8810", kind: "lan", priority: 200 },
      { url: "http://openmausbot-abcd1234.local:8810", kind: "bonjour", priority: 300 },
    ]);
  });

  it("tries custom HTTPS origins after the managed hosted route and before direct ones", () => {
    expect(
      companionEndpointCandidates(
        8810,
        ["100.121.5.6", "192.168.1.42"],
        "macbook.tail1234.ts.net",
        "https://device-123.companion.example",
        "openmausbot-abcd1234.local",
        ["https://relay.example", "https://relay2.example:8443"],
      ),
    ).toEqual([
      { url: "https://device-123.companion.example", kind: "hosted", priority: 0 },
      { url: "https://relay.example", kind: "hosted", priority: 50 },
      { url: "https://relay2.example:8443", kind: "hosted", priority: 51 },
      { url: "http://macbook.tail1234.ts.net:8810", kind: "tailnet", priority: 100 },
      { url: "http://192.168.1.42:8810", kind: "lan", priority: 201 },
      { url: "http://openmausbot-abcd1234.local:8810", kind: "bonjour", priority: 300 },
    ]);
  });

  it("keeps one entry when a custom origin repeats the managed hosted route", () => {
    expect(
      companionEndpointCandidates(8810, [], null, "https://device-123.companion.example", null, ["https://device-123.companion.example"]),
    ).toEqual([{ url: "https://device-123.companion.example", kind: "hosted", priority: 0 }]);
  });

  it("caps pathological interface lists without losing the Bonjour fallback", () => {
    const addresses = Array.from({ length: 20 }, (_, index) => `192.168.1.${index + 1}`);
    const endpoints = companionEndpointCandidates(
      8810,
      addresses,
      null,
      "https://device-123.companion.example",
      "openmausbot-abcd1234.local",
    );
    expect(endpoints).toHaveLength(MAX_COMPANION_ENDPOINTS);
    expect(endpoints[0]).toMatchObject({ kind: "hosted", priority: 0 });
    expect(endpoints.at(-1)).toEqual({
      url: "http://openmausbot-abcd1234.local:8810",
      kind: "bonjour",
      priority: 300,
    });
  });
});

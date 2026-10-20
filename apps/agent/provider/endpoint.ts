import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { Agent, fetch as httpFetch } from "undici";

const denied = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  denied.addSubnet(network, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
for (const [network, prefix] of [
  ["2001::", 32],
  ["2001:db8::", 32],
  ["2002::", 16],
] as const)
  denied.addSubnet(network, prefix, "ipv6");
export function publicAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4
    ? !denied.check(address, "ipv4")
    : family === 6 &&
        globalV6.check(address, "ipv6") &&
        !denied.check(address, "ipv6");
}
export function providerEndpoint(baseUrl: string, protocolTest: boolean) {
  const base = new URL(baseUrl);
  const test =
    protocolTest && base.protocol === "http:" && base.hostname === "127.0.0.1";
  if (
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    (!test &&
      (base.protocol !== "https:" ||
        isIP(base.hostname.replace(/^\[|\]$/g, "")) ||
        base.hostname === "localhost" ||
        /\.(localhost|local)\.?$/i.test(base.hostname)))
  )
    throw new Error("provider_configuration_invalid");
  // 每次新连接在DNS结果处拒绝非公网地址；只将已验证地址交给连接器，阻止DNS重绑定。
  const dispatcher = new Agent({
    connect: {
      lookup: (hostname, options, callback) => {
        void lookup(hostname, { all: true })
          .then((addresses) => {
            if (
              !addresses.length ||
              addresses.some((item) => !publicAddress(item.address))
            ) {
              callback(new Error("provider_endpoint_rejected"), [], undefined);
              return;
            }
            const available = options.family
              ? addresses.filter((item) => item.family === options.family)
              : addresses;
            if (!available.length) {
              callback(new Error("provider_endpoint_rejected"), [], undefined);
              return;
            }
            if (options.all) callback(null, available, undefined);
            else callback(null, available[0].address, available[0].family);
          })
          .catch(() =>
            callback(new Error("provider_endpoint_unavailable"), [], undefined),
          );
      },
    },
  });
  return {
    fetch: (async (input, init) => {
      if (test) return fetch(input, { ...init, redirect: "error" });
      return (await httpFetch(
        input instanceof Request ? input.url : String(input),
        {
          method: init?.method,
          headers: Object.fromEntries(new Headers(init?.headers)),
          signal: init?.signal,
          body: init?.body as string | undefined,
          dispatcher,
          redirect: "error",
        },
      )) as unknown as Response;
    }) satisfies typeof fetch,
    close: () => dispatcher.close(),
  };
}

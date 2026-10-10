/**
 * The two standing prohibitions, quoted verbatim in the setup prompt.
 *
 * They live here rather than inside the prose so that the prompt and its tests share one source: a
 * reworded ban must not be able to drift away from what the tests assert, and dropping one must fail a
 * test rather than pass silently.
 *
 * @module dsh-fleet/prompt-rules
 */

/**
 * Why this exists: the reader is being handed a private key's PUBLIC half and an SSH account to
 * configure. The failure mode is a helpful agent "making things work" by copying the private key over,
 * which puts the credential on every machine that was meant to be controlled by it.
 */
export const NO_PRIVATE_KEY_RULE = '不要把任何私钥复制到本机 —— 私钥只存在于主控机';

/**
 * Why this exists: the `acp` profile declares two bundles that ship with DSH itself. An agent that sees
 * a `package.json` with `dependencies: {}` and decides to install things wastes time and can break the
 * profile's resolution.
 */
export const NO_INSTALL_RULE = '不要安装任何新依赖 —— 需要的东西随 DSH 自带';

/**
 * Why this exists: the address a machine reports for itself is the field the controller CANNOT verify, and the
 * one whose failure is least informative. A machine with a VPN reports the tunnel address first, and the
 * controller then records an address that only works from inside that tunnel. Measured: a controller had
 * `10.8.0.2` on a VPN ahead of `192.168.1.20` on WLAN, and only the second was reachable from the other side.
 *
 * Kept here so the prompt and its tests share one source, like the two bans above.
 */
export const ADDRESS_RULE = '报地址时排除 VPN 与虚拟网卡（tun/tap/wg/utun/docker/veth 等），优先与主控机同网段的那个';

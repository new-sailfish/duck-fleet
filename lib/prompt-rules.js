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

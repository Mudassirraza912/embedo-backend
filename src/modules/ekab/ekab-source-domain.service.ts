import { prisma } from '../../db/prisma.js';
import { AppError } from '../../common/errors/AppError.js';
import { SourceDomainInput } from './ekab.validation.js';

/**
 * The scraper's allowlist, managed from the admin panel. A host is either fetched (PUBLIC /
 * LICENSED_REFERENCE_ONLY) or, when RESTRICTED, never fetched: a URL on it is recorded as a
 * RESTRICTED_SOURCE gap with whatever bibliographic details the admin entered (contract §7.2).
 */

type Actor = { label: string };

/**
 * Suggested starting list. Added only when an admin clicks "Add recommended sites", so a site the
 * admin removed is not put back by a deploy. Four of them (TI, RFC Editor, Espressif docs, Zephyr
 * docs) are also inserted once by the `20261021120000_ekab_trusted_sources` migration.
 */
export const RECOMMENDED_SOURCE_DOMAINS: SourceDomainInput[] = [
  { host: '.rfc-editor.org', publisher: 'IETF (RFC Editor)', defaultSourceType: 'STANDARD', accessState: 'PUBLIC', notes: 'Published RFCs (IP, transport, CoAP, MQTT-SN references, TLS…). Free to read.' },
  { host: 'datatracker.ietf.org', publisher: 'IETF', defaultSourceType: 'STANDARD', accessState: 'PUBLIC', notes: 'RFCs and drafts. Prefer published RFCs over drafts.' },
  { host: '.modbus.org', publisher: 'Modbus Organization', defaultSourceType: 'STANDARD', accessState: 'PUBLIC', notes: 'Modbus application protocol and serial-line specifications.' },
  { host: '.usb.org', publisher: 'USB Implementers Forum', defaultSourceType: 'STANDARD', accessState: 'PUBLIC', notes: 'USB 2.0 / Type-C / USB PD specification downloads.' },
  { host: '.lora-alliance.org', publisher: 'LoRa Alliance', defaultSourceType: 'STANDARD', accessState: 'PUBLIC', notes: 'LoRaWAN specifications and regional parameters.' },
  { host: '.bluetooth.com', publisher: 'Bluetooth SIG', defaultSourceType: 'STANDARD', accessState: 'PUBLIC', notes: 'Bluetooth Core Specification pages.' },
  { host: '.ti.com', publisher: 'Texas Instruments', defaultSourceType: 'APP_NOTE', accessState: 'PUBLIC', notes: 'Application reports and datasheets.' },
  { host: '.analog.com', publisher: 'Analog Devices', defaultSourceType: 'APP_NOTE', accessState: 'PUBLIC', notes: 'Application notes, technical articles, datasheets.' },
  { host: '.nxp.com', publisher: 'NXP Semiconductors', defaultSourceType: 'APP_NOTE', accessState: 'PUBLIC', notes: 'Application notes and user manuals (e.g. the I²C-bus specification).' },
  { host: '.st.com', publisher: 'STMicroelectronics', defaultSourceType: 'APP_NOTE', accessState: 'PUBLIC', notes: 'Application notes and reference manuals.' },
  { host: '.microchip.com', publisher: 'Microchip Technology', defaultSourceType: 'APP_NOTE', accessState: 'PUBLIC', notes: 'Application notes and datasheets.' },
  { host: 'docs.zephyrproject.org', publisher: 'Zephyr Project', defaultSourceType: 'OFFICIAL_DOC', accessState: 'PUBLIC', notes: 'Official RTOS and driver documentation. robots.txt allows only /latest/… pages, so use /latest/ links.' },
  { host: 'docs.espressif.com', publisher: 'Espressif Systems', defaultSourceType: 'OFFICIAL_DOC', accessState: 'PUBLIC', notes: 'ESP-IDF programming guide and peripheral docs (I2C, SPI, UART, TWAI/CAN) for ESP32 controllers.' },
  { host: '.freertos.org', publisher: 'FreeRTOS', defaultSourceType: 'OFFICIAL_DOC', accessState: 'PUBLIC', notes: 'Official kernel documentation.' },
  { host: '.ieee.org', publisher: 'IEEE', defaultSourceType: 'STANDARD', accessState: 'RESTRICTED', notes: 'Standards text is behind login/paywall and automated downloading is not permitted. Metadata only; recorded as a gap.' },
  { host: '.iec.ch', publisher: 'IEC', defaultSourceType: 'STANDARD', accessState: 'RESTRICTED', notes: 'Paid standards. Metadata only; recorded as a gap.' },
  { host: '.iso.org', publisher: 'ISO', defaultSourceType: 'STANDARD', accessState: 'RESTRICTED', notes: 'Paid standards. Metadata only; recorded as a gap.' },
  { host: '.jedec.org', publisher: 'JEDEC', defaultSourceType: 'STANDARD', accessState: 'RESTRICTED', notes: 'Standards downloads need an account. Metadata only; recorded as a gap.' },
  { host: '.ipc.org', publisher: 'IPC', defaultSourceType: 'STANDARD', accessState: 'RESTRICTED', notes: 'Paid standards. Metadata only; recorded as a gap.' },
];

const select = { id: true, host: true, publisher: true, defaultSourceType: true, accessState: true, enabled: true, notes: true, createdBy: true, createdAt: true, updatedAt: true } as const;

/** The allowlist entry that covers a host (exact match wins over the longest matching suffix). */
export function matchSourceDomain<T extends { host: string }>(hostname: string, domains: T[]): T | null {
  const h = hostname.toLowerCase();
  const exact = domains.find((d) => d.host === h);
  if (exact) return exact;
  return (
    domains
      .filter((d) => d.host.startsWith('.') && (h.endsWith(d.host) || h === d.host.slice(1)))
      .sort((a, b) => b.host.length - a.host.length)[0] ?? null
  );
}

export const ekabSourceDomainService = {
  list() {
    return prisma.ekabSourceDomain.findMany({ select, orderBy: [{ accessState: 'asc' }, { host: 'asc' }] });
  },

  async create(input: SourceDomainInput, actor: Actor) {
    const exists = await prisma.ekabSourceDomain.findUnique({ where: { host: input.host }, select: { id: true } });
    if (exists) throw new AppError(409, 'CONFLICT', `${input.host} is already on the list.`);
    return prisma.ekabSourceDomain.create({ data: { ...input, notes: input.notes ?? null, createdBy: actor.label.slice(0, 120) }, select });
  },

  async update(id: string, patch: Partial<Omit<SourceDomainInput, 'host'>>) {
    const exists = await prisma.ekabSourceDomain.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw new AppError(404, 'NOT_FOUND', 'Source domain not found');
    return prisma.ekabSourceDomain.update({ where: { id }, data: patch, select });
  },

  async remove(id: string) {
    const exists = await prisma.ekabSourceDomain.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw new AppError(404, 'NOT_FOUND', 'Source domain not found');
    await prisma.ekabSourceDomain.delete({ where: { id } });
    return { id, removed: true };
  },

  /** Adds the recommended sites that are not on the list yet. Never changes existing entries. */
  async addRecommended(actor: Actor) {
    const result = await prisma.ekabSourceDomain.createMany({
      data: RECOMMENDED_SOURCE_DOMAINS.map((d) => ({ ...d, notes: d.notes ?? null, createdBy: actor.label.slice(0, 120) })),
      skipDuplicates: true,
    });
    return { added: result.count, domains: await this.list() };
  },
};

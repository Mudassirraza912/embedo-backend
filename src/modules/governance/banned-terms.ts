export interface BannedTermRule {
  category: 'weapons' | 'explosives' | 'jamming' | 'surveillance' | 'hacking_bypass' | 'profanity';
  pattern: RegExp;
  reason: string;
}

export const HARDWARE_POLICY_RULES: BannedTermRule[] = [
  // 1. Explosives & Weapon Triggers
  {
    category: 'explosives',
    pattern: /\b(bomb|detonat(or|ion)|ied|c4|dynamite|explosive\s+trigger|blast\s+circuit|missile\s+guidance)\b/i,
    reason: 'Hardware designs for munitions, explosives, or detonation triggers are strictly prohibited.',
  },
  {
    category: 'weapons',
    pattern: /\b(lethal\s+weapon|firearm\s+trigger|gun\s+controller|weaponized\s+drone|autonomous\s+kill\s+switch)\b/i,
    reason: 'Hardware designs for weapons or weapon control systems are strictly prohibited.',
  },

  // 2. Illegal RF Jamming & Network Disruption
  {
    category: 'jamming',
    pattern: /\b(rf\s+jammer|gps\s+jammer|wifi\s+jammer|gsm\s+jammer|cellular\s+blocker|signal\s+disruptor|deauth\s+jammer)\b/i,
    reason: 'Radio frequency jamming and signal disruption devices violate telecommunication regulations.',
  },

  // 3. Unauthorized Surveillance & Wiretapping
  {
    category: 'surveillance',
    pattern: /\b(covert\s+wiretap|hidden\s+audio\s+bug|unauthorized\s+keylogger|secret\s+intercept|spy\s+recorder\s+tamper)\b/i,
    reason: 'Covert unauthorized surveillance and wiretapping devices are prohibited.',
  },

  // 4. Physical Security / Access Control Bypass & Hacking
  {
    category: 'hacking_bypass',
    pattern: /\b(atm\s+skimmer|card\s+cloner\s+tamper|lock\s+bypass\s+pick|anti-theft\s+defeater|rfid\s+replay\s+theft)\b/i,
    reason: 'Hardware intended for security bypass, card skimming, or physical theft is prohibited.',
  },

  // 5. Profanity / Abusive Content
  {
    category: 'profanity',
    pattern: /\b(fuck|shit|bitch|bastard|asshole|cunt|nigger|faggot)\b/i,
    reason: 'Abusive language and profanity are not permitted.',
  },
];

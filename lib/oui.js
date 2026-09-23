/**
 * Compact OUI (MAC prefix) -> Vendor lookup.
 * Only the most common consumer/IoT vendors are included to keep it lightweight.
 * Prefix is the first 3 bytes (uppercase, no separators).
 */
const OUI_MAP = {
  '000C29': 'VMware', '005056': 'VMware', '001C42': 'Parallels',
  'DC A6 32': 'Raspberry Pi', 'DCA632': 'Raspberry Pi', 'B827EB': 'Raspberry Pi', 'E45F01': 'Raspberry Pi',
  '3C71BF': 'Espressif (ESP32)', '240AC4': 'Espressif (ESP32)', '3C6105': 'Espressif (ESP32)',
  'A020A6': 'Espressif (ESP32)', '7C9EBD': 'Espressif (ESP32)', '84CCA8': 'Espressif (ESP32)',
  'BCDDC2': 'Espressif (ESP32)', 'D8A01D': 'Espressif (ESP32)', 'EC94CB': 'Espressif (ESP32)',
  '001A11': 'Google', '3C5AB4': 'Google', 'F4F5D8': 'Google', 'DA A1 19': 'Google',
  'F0EF86': 'Google Nest', '00248C': 'ASUSTek', '2C56DC': 'ASUSTek', '04D4C4': 'ASUSTek',
  'AC220B': 'ASUSTek', '001018': 'Broadcom', 'D85D4C': 'TP-Link', '50C7BF': 'TP-Link',
  'A42BB0': 'TP-Link', 'EC086B': 'TP-Link', '9C5322': 'Compal/TP', '14CC20': 'TP-Link',
  '001374': 'Atheros', '000E8F': 'Sercomm', 'F81A67': 'TP-Link', 'C46E1F': 'TP-Link',
  '3C84 6A': 'TP-Link', '001B63': 'Apple', '001EC2': 'Apple', '3C0754': 'Apple',
  'A85C2C': 'Apple', 'F0DBF8': 'Apple', 'D0817A': 'Apple', 'AC BC 32': 'Apple',
  'F4F15A': 'Apple', '90B21F': 'Apple', 'DC2B2A': 'Apple', '8866A5': 'Apple',
  '001377': 'Samsung', '0021D1': 'Samsung', '5CF6DC': 'Samsung', '8425DB': 'Samsung',
  'E8508B': 'Samsung', 'C4576E': 'Samsung', '380195': 'Samsung', 'FCA13E': 'Samsung',
  '001377S': 'Samsung', '002454': 'Huawei', '00464B': 'Huawei', '48435A': 'Huawei',
  '4CB16C': 'Huawei', '8C34FD': 'Huawei', 'AC853D': 'Huawei', 'F80332': 'Xiaomi',
  '286C07': 'Xiaomi', '3480B3': 'Xiaomi', '640980': 'Xiaomi', '7451BA': 'Xiaomi',
  '9C99A0': 'Xiaomi', 'F0B429': 'Xiaomi', '00166C': 'Samsung', '001632': 'Samsung',
  '000B86': 'Aruba/HP', '0024D7': 'Intel', '3C970E': 'Intel', '5CE0C5': 'Intel',
  '7C7A91': 'Intel', 'A0A8CD': 'Intel', 'E4B318': 'Intel', '001E58': 'D-Link',
  '14D64D': 'D-Link', '340804': 'D-Link', '00179A': 'D-Link', 'C8D3A3': 'D-Link',
  '002401': 'D-Link', '000FB5': 'Netgear', '20E52A': 'Netgear', '9C3DCF': 'Netgear',
  'A040A0': 'Netgear', 'C03F0E': 'Netgear', '000625': 'Linksys', '48F8B3': 'Linksys',
  '58EF68': 'Belkin', '944452': 'Belkin', 'EC1A59': 'Belkin', '001AA0': 'Dell',
  'B8AC6F': 'Dell', 'F8BC12': 'Dell', '18DBF2': 'Dell', 'D067E5': 'Dell',
  '0050F2': 'Microsoft', '7CED8D': 'Microsoft', '60455E': 'Microsoft', '000D3A': 'Microsoft',
  '00037F': 'Atheros', '001966': 'Samsung', '5CAAFD': 'Sonos', '949F3E': 'Sonos',
  'B8E937': 'Sonos', '000E58': 'Sonos', 'ECB5FA': 'Philips Hue', '001788': 'Philips Hue',
  'B0F893': 'Amazon', '68DBF5': 'Amazon', '0C47C9': 'Amazon', '44650D': 'Amazon',
  'FC65DE': 'Amazon', '38F73D': 'Amazon', '68542A': 'Amazon', 'A002DC': 'Amazon',
  'CC50E3': 'Espressif (ESP32)', '54430D': 'Sichuan', '083AF2': 'Espressif (ESP32)'
};

function normalizeMac(mac) {
  return String(mac || '').toUpperCase().replace(/[^0-9A-F]/g, '');
}

function lookupVendor(mac) {
  const clean = normalizeMac(mac);
  if (clean.length < 6) return 'Desconocido';
  const prefix = clean.slice(0, 6);
  if (OUI_MAP[prefix]) return OUI_MAP[prefix];
  // Locally administered / randomized MAC (2nd hex nibble is 2,6,A,E)
  const secondNibble = clean[1];
  if (['2', '6', 'A', 'E'].includes(secondNibble)) return 'MAC Aleatoria (privacidad)';
  return 'Desconocido';
}

function isRandomMac(mac) {
  const clean = normalizeMac(mac);
  if (clean.length < 2) return false;
  return ['2', '6', 'A', 'E'].includes(clean[1]);
}

module.exports = { lookupVendor, isRandomMac, normalizeMac };

import { createHash } from 'node:crypto';

/** Escapes text for XML element content and attribute values. */
export function xml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** Mozilla autoconfig (Thunderbird and others): https://wiki.mozilla.org/Thunderbird:Autoconfiguration:ConfigFileFormat */
export function autoconfigXml(domain: string, mailHost: string): string {
  const d = xml(domain);
  const h = xml(mailHost);
  return `<?xml version="1.0" encoding="UTF-8"?>
<clientConfig version="1.1">
  <emailProvider id="${d}">
    <domain>${d}</domain>
    <displayName>${d}</displayName>
    <displayShortName>${d}</displayShortName>
    <incomingServer type="imap">
      <hostname>${h}</hostname>
      <port>993</port>
      <socketType>SSL</socketType>
      <authentication>password-cleartext</authentication>
      <username>%EMAILADDRESS%</username>
    </incomingServer>
    <incomingServer type="pop3">
      <hostname>${h}</hostname>
      <port>995</port>
      <socketType>SSL</socketType>
      <authentication>password-cleartext</authentication>
      <username>%EMAILADDRESS%</username>
    </incomingServer>
    <outgoingServer type="smtp">
      <hostname>${h}</hostname>
      <port>465</port>
      <socketType>SSL</socketType>
      <authentication>password-cleartext</authentication>
      <username>%EMAILADDRESS%</username>
    </outgoingServer>
    <documentation url="https://${h}/">
      <descr lang="en">Use an app password, created in your account settings.</descr>
    </documentation>
  </emailProvider>
  <addressBook type="carddav">
    <username>%EMAILADDRESS%</username>
    <authentication>http-basic</authentication>
    <serverURL>https://${h}/dav/addressbooks/user/%EMAILADDRESS%/</serverURL>
  </addressBook>
  <calendar type="caldav">
    <username>%EMAILADDRESS%</username>
    <authentication>http-basic</authentication>
    <serverURL>https://${h}/dav/calendars/user/%EMAILADDRESS%/</serverURL>
  </calendar>
</clientConfig>
`;
}

/** Outlook's POX Autodiscover response (IMAP and SMTP settings for a mailbox). */
export function autodiscoverXml(email: string, mailHost: string): string {
  const e = xml(email);
  const h = xml(mailHost);
  return `<?xml version="1.0" encoding="utf-8"?>
<Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/responseschema/2006">
  <Response xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a">
    <Account>
      <AccountType>email</AccountType>
      <Action>settings</Action>
      <Protocol>
        <Type>IMAP</Type>
        <Server>${h}</Server>
        <Port>993</Port>
        <LoginName>${e}</LoginName>
        <DomainRequired>off</DomainRequired>
        <SPA>off</SPA>
        <SSL>on</SSL>
        <AuthRequired>on</AuthRequired>
      </Protocol>
      <Protocol>
        <Type>SMTP</Type>
        <Server>${h}</Server>
        <Port>465</Port>
        <LoginName>${e}</LoginName>
        <DomainRequired>off</DomainRequired>
        <SPA>off</SPA>
        <SSL>on</SSL>
        <AuthRequired>on</AuthRequired>
        <UsePOPAuth>on</UsePOPAuth>
      </Protocol>
    </Account>
  </Response>
</Autodiscover>
`;
}

export type MtaStsMode = 'enforce' | 'testing' | 'none';

/** The MTA-STS policy (RFC 8461) for domains whose mail goes to `mailHost`. */
export function mtaStsPolicy(mode: MtaStsMode, mailHost: string): string {
  return `version: STSv1\nmode: ${mode}\nmx: ${mailHost}\nmax_age: ${mode === 'none' ? 86400 : 604800}\n`;
}

/** The policy id published in DNS: changes whenever the policy text changes. */
export function mtaStsPolicyId(policy: string): string {
  return createHash('sha256').update(policy).digest('hex').slice(0, 16);
}

/** "alice@Example.COM" → "example.com"; null for anything that is not an address. */
export function domainOfAddress(email: string): string | null {
  const match = /^[^@\s]{1,64}@([a-z0-9.-]{1,253})$/i.exec(email.trim());
  return match ? match[1]!.toLowerCase().replace(/\.$/, '') : null;
}

/** Outlook posts <EMailAddress>…</EMailAddress> inside its request. */
export function emailFromAutodiscoverRequest(body: string): string | null {
  const match = /<EMailAddress>\s*([^<\s]{3,320})\s*<\/EMailAddress>/i.exec(body);
  return match ? match[1]! : null;
}

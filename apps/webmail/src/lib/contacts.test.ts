import type { Contact } from '@postarix/jmap-client';
import { describe, expect, it } from 'vitest';
import { contactName, matchesContact, sortContacts } from './contacts';

const c = (over: Partial<Contact>): Contact => ({
  id: Math.random().toString(36), firstName: '', lastName: '', company: '', jobTitle: '', nickname: '', notes: '', emails: [], phones: [], ...over,
});

describe('contacts', () => {
  it('names people, then companies, then addresses', () => {
    expect(contactName(c({ firstName: 'Lucía', lastName: 'Gómez' }))).toBe('Lucía Gómez');
    expect(contactName(c({ company: 'Acme' }))).toBe('Acme');
    expect(contactName(c({ emails: [{ type: 'work', value: 'x@y.z' }] }))).toBe('x@y.z');
  });

  it('sorts by last name and searches every field', () => {
    const list = sortContacts([c({ firstName: 'Zoe', lastName: 'Adams' }), c({ firstName: 'Ann', lastName: 'Young' }), c({ company: 'Bakery' })]);
    expect(list.map(contactName)).toEqual(['Zoe Adams', 'Bakery', 'Ann Young']);
    const lucia = c({ firstName: 'Lucía', phones: [{ type: 'mobile', value: '+57 300 1234567' }], emails: [{ type: 'work', value: 'lucia@acme.example' }] });
    expect(matchesContact(lucia, 'ACME')).toBe(true);
    expect(matchesContact(lucia, '300 12')).toBe(true);
    expect(matchesContact(lucia, 'bob')).toBe(false);
  });
});

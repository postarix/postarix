import { JmapClient } from '@postarix/jmap-client';

/** JMAP through the Postarix API, as the signed-in user. */
export const jmap = new JmapClient({ sessionUrl: '/api/jmap/' });

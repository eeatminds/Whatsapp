import type { Core } from '../context.js';
import { Bus } from './bus.js';
import { SettingsService, defaultSettings } from './settings.js';
import { TagsService } from './tags.js';
import { SegmentsService } from './segments.js';
import { ContactsService } from './contacts.js';
import { MediaService } from './media.js';
import { TemplatesService } from './templates.js';
import { MessagesService } from './messages.js';
import { Sender } from './sender.js';
import { SessionsService } from './sessions.js';
import { CampaignsService } from './campaigns.js';
import { SequencesService } from './sequences.js';
import { OutboxService } from './outbox.js';
import { AutoRepliesService } from './auto-replies.js';
import { InboundService } from './inbound.js';
import { Dispatcher } from './dispatcher.js';
import { AnalyticsService } from './analytics.js';

export function createServices(core: Core, options: { random?: () => number } = {}) {
  const bus = new Bus();
  const settings = new SettingsService(core.db, defaultSettings());
  const tags = new TagsService(core);
  const segments = new SegmentsService(core);
  const contacts = new ContactsService(core, settings, tags, segments, bus);
  const media = new MediaService(core);
  const templates = new TemplatesService(core, media, contacts, settings);
  const messages = new MessagesService(core);
  const sender = new Sender(core, media);
  const sessions = new SessionsService(core);
  const campaigns = new CampaignsService(core, settings, segments, media, sender, messages);
  const sequences = new SequencesService(core, settings, media, tags, bus);
  const outbox = new OutboxService(core);
  const autoReplies = new AutoRepliesService(core, settings, media, tags, contacts, sequences, outbox);
  const inbound = new InboundService(core, settings, contacts, messages, campaigns, autoReplies, outbox, sessions, bus);
  const dispatcher = new Dispatcher(
    core,
    { settings, sessions, campaigns, sequences, messages, outbox, contacts, sender, inbound, autoReplies },
    options.random,
  );
  const analytics = new AnalyticsService(core, settings, contacts, messages);
  return {
    bus,
    settings,
    tags,
    segments,
    contacts,
    media,
    templates,
    messages,
    sender,
    sessions,
    campaigns,
    sequences,
    outbox,
    autoReplies,
    inbound,
    dispatcher,
    analytics,
  };
}

export type Services = ReturnType<typeof createServices>;

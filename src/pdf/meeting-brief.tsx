import {
  Document,
  Page,
  View,
  Text,
  Image,
  StyleSheet,
  renderToBuffer,
} from '@react-pdf/renderer';
import type { Attendee, QrPayload } from '@/types';
import { generateQrDataUrl } from '@/lib/qr';
import type { BriefOutput, CrmSection } from '@/lib/anthropic';

const ACCENT = '#B85C38';
const INK = '#1a1a1a';
const MUTED = '#666';

const styles = StyleSheet.create({
  page: {
    padding: 36,
    fontSize: 10,
    fontFamily: 'Helvetica',
    color: INK,
  },
  headerBand: {
    borderLeftWidth: 3,
    borderLeftColor: ACCENT,
    paddingLeft: 10,
    marginBottom: 14,
  },
  title: { fontSize: 16, fontFamily: 'Helvetica-Bold', marginBottom: 4 },
  meta: { fontSize: 9, color: MUTED },
  section: { marginBottom: 10 },
  sectionLabel: {
    fontSize: 8,
    fontFamily: 'Helvetica-Bold',
    color: MUTED,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  body: { fontSize: 10, lineHeight: 1.4 },
  bullet: { flexDirection: 'row', marginBottom: 2 },
  bulletDot: { width: 10, fontSize: 10 },
  bulletText: { flex: 1, fontSize: 10, lineHeight: 1.35 },
  crmHeader: {
    fontSize: 8,
    fontFamily: 'Helvetica-Bold',
    color: MUTED,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  crmFlags: {
    borderLeftWidth: 2,
    borderLeftColor: ACCENT,
    paddingLeft: 8,
    marginTop: 6,
  },
  notesZone: { flexGrow: 1, minHeight: 380, marginTop: 8 },
  notesLine: { height: 22, borderBottomWidth: 0.5, borderBottomColor: '#d4d4d4' },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 10,
  },
  qr: { width: 25, height: 25 },
  filename: { fontSize: 7, fontFamily: 'Courier', color: MUTED },
});

function formatAttendeeList(attendees: Attendee[]): string {
  const max = 6;
  const shown = attendees.slice(0, max).map((a) => a.name ?? a.email);
  if (attendees.length > max) shown.push(`+ ${attendees.length - max} more`);
  return shown.join(', ') || '(none)';
}

function Bullets({ items }: { items: string[] }) {
  return (
    <View>
      {items.map((it, i) => (
        <View key={i} style={styles.bullet}>
          <Text style={styles.bulletDot}>•</Text>
          <Text style={styles.bulletText}>{it}</Text>
        </View>
      ))}
    </View>
  );
}

const LENS_LABELS: Record<CrmSection['lens'], string> = {
  customer: 'CRM — Customer view',
  seller: 'CRM — Seller 1:1',
  sales_leader: 'CRM — Executive view',
  none: 'CRM',
};

const MAX_FACTS = 6;
const MAX_FLAGS = 6;

function truncate(items: string[], max: number): string[] {
  if (items.length <= max) return items;
  const head = items.slice(0, max);
  head.push(`+ ${items.length - max} more`);
  return head;
}

function CrmBlock({ section }: { section: CrmSection }) {
  if (section.lens === 'none') return null;
  if (section.facts.length === 0 && section.flags.length === 0) return null;
  const facts = truncate(section.facts, MAX_FACTS);
  const flags = truncate(section.flags, MAX_FLAGS);
  return (
    <View style={styles.section}>
      <Text style={styles.crmHeader}>{LENS_LABELS[section.lens]}</Text>
      {facts.length > 0 && <Bullets items={facts} />}
      {flags.length > 0 && (
        <View style={styles.crmFlags}>
          <Bullets items={flags} />
        </View>
      )}
    </View>
  );
}

export type MeetingBriefPdfInput = {
  meeting: {
    id: string;
    seriesId: string;
    title: string;
    date: string;
    startTime: string;
    endTime: string;
    attendees: Attendee[];
  };
  brief: BriefOutput;
  filename: string;
};

function MeetingBriefDoc(props: MeetingBriefPdfInput & { qrDataUrl: string }) {
  const { meeting, brief, filename, qrDataUrl } = props;
  const notesLineCount = 18;

  return (
    <Document>
      <Page size="LETTER" style={styles.page}>
        <View style={styles.headerBand}>
          <Text style={styles.title}>{meeting.title}</Text>
          <Text style={styles.meta}>
            {meeting.date}  ·  {meeting.startTime}–{meeting.endTime} MT
          </Text>
          <Text style={styles.meta}>{formatAttendeeList(meeting.attendees)}</Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Context</Text>
          <Text style={styles.body}>{brief.context}</Text>
        </View>

        {brief.open_threads.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>Open threads</Text>
            <Bullets items={brief.open_threads} />
          </View>
        )}

        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Agenda</Text>
          <Bullets items={brief.agenda_suggestions} />
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Questions</Text>
          <Bullets items={brief.questions_to_ask} />
        </View>

        {brief.prep_notes.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>Prep</Text>
            <Bullets items={brief.prep_notes} />
          </View>
        )}

        {brief.crm_section && <CrmBlock section={brief.crm_section} />}

        <View style={styles.notesZone}>
          {Array.from({ length: notesLineCount }).map((_, i) => (
            <View key={i} style={styles.notesLine} />
          ))}
        </View>

        <View style={styles.footer} fixed>
          {qrDataUrl ? (
            // eslint-disable-next-line jsx-a11y/alt-text
            <Image src={qrDataUrl} style={styles.qr} />
          ) : (
            <View style={styles.qr} />
          )}
          <Text style={styles.filename}>{filename}</Text>
        </View>
      </Page>
    </Document>
  );
}

export async function renderMeetingBriefPdf(input: MeetingBriefPdfInput): Promise<Buffer> {
  const payload: QrPayload = {
    meetingId: input.meeting.id,
    seriesId: input.meeting.seriesId,
    date: input.meeting.date,
    version: 1,
  };
  const qrDataUrl = await generateQrDataUrl(payload);
  return renderToBuffer(<MeetingBriefDoc {...input} qrDataUrl={qrDataUrl} />);
}

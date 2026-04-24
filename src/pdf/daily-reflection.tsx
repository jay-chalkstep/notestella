import {
  Document,
  Page,
  View,
  Text,
  Image,
  StyleSheet,
  renderToBuffer,
} from '@react-pdf/renderer';
import type { QrPayload } from '@/types';
import { generateQrDataUrl } from '@/lib/qr';
import type { DailyReflectionOutput, ActionItem } from '@/lib/anthropic';

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
  title: { fontSize: 16, fontFamily: 'Helvetica-Bold' },
  section: { marginBottom: 12 },
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
  prompt: {
    marginTop: 20,
    marginBottom: 16,
    textAlign: 'center',
    fontSize: 13,
    fontStyle: 'italic',
    color: INK,
  },
  responseZone: { flexGrow: 1, minHeight: 180, marginTop: 8 },
  responseLine: { height: 22, borderBottomWidth: 0.5, borderBottomColor: '#d4d4d4' },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 10,
  },
  qr: { width: 25, height: 25 },
  dateText: { fontSize: 8, color: MUTED, fontFamily: 'Courier' },
});

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

function ActionItems({ items }: { items: ActionItem[] }) {
  return (
    <View>
      {items.map((it, i) => {
        const tail = [it.owner, it.due].filter(Boolean).join(' · ');
        const text = tail ? `${it.description}  (${tail})` : it.description;
        return (
          <View key={i} style={styles.bullet}>
            <Text style={styles.bulletDot}>•</Text>
            <Text style={styles.bulletText}>{text}</Text>
          </View>
        );
      })}
    </View>
  );
}

export type DailyReflectionPdfInput = {
  date: string;
  formattedDate: string;
  reflection: DailyReflectionOutput;
};

function DailyReflectionDoc(props: DailyReflectionPdfInput & { qrDataUrl: string }) {
  const { date, formattedDate, reflection, qrDataUrl } = props;
  const lineCount = 10;

  return (
    <Document>
      <Page size="LETTER" style={styles.page}>
        <View style={styles.headerBand}>
          <Text style={styles.title}>Daily Reflection — {formattedDate}</Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Day in review</Text>
          <Text style={styles.body}>{reflection.day_in_review}</Text>
        </View>

        {reflection.decisions_made.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>Decisions</Text>
            <Bullets items={reflection.decisions_made} />
          </View>
        )}

        {reflection.new_action_items.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>New action items</Text>
            <ActionItems items={reflection.new_action_items} />
          </View>
        )}

        {reflection.open_threads.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>Open threads</Text>
            <Bullets items={reflection.open_threads} />
          </View>
        )}

        {reflection.patterns_noticed.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>Patterns</Text>
            <Bullets items={reflection.patterns_noticed} />
          </View>
        )}

        <Text style={styles.prompt}>{reflection.reflective_prompt}</Text>

        <View style={styles.responseZone}>
          {Array.from({ length: lineCount }).map((_, i) => (
            <View key={i} style={styles.responseLine} />
          ))}
        </View>

        <View style={styles.footer} fixed>
          <Text style={styles.dateText}>{date}</Text>
          {qrDataUrl ? (
            // eslint-disable-next-line jsx-a11y/alt-text
            <Image src={qrDataUrl} style={styles.qr} />
          ) : (
            <View style={styles.qr} />
          )}
        </View>
      </Page>
    </Document>
  );
}

export async function renderDailyReflectionPdf(
  input: DailyReflectionPdfInput
): Promise<Buffer> {
  const payload: QrPayload = {
    meetingId: 'reflection-daily',
    seriesId: 'reflection',
    date: input.date,
    version: 1,
  };
  const qrDataUrl = await generateQrDataUrl(payload);
  return renderToBuffer(<DailyReflectionDoc {...input} qrDataUrl={qrDataUrl} />);
}

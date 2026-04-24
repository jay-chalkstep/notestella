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
import type { WeeklyReflectionOutput } from '@/lib/anthropic';

const ACCENT = '#B85C38';
const INK = '#1a1a1a';
const MUTED = '#666';
const BORDER = '#d4d4d4';

const styles = StyleSheet.create({
  page: {
    padding: 32,
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
  subtitle: { fontSize: 9, color: MUTED, marginTop: 2 },
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
  columns: { flexDirection: 'row', gap: 12 },
  col: { flex: 1 },
  table: { borderTopWidth: 0.5, borderTopColor: BORDER, marginTop: 4 },
  row: {
    flexDirection: 'row',
    borderBottomWidth: 0.5,
    borderBottomColor: BORDER,
    paddingVertical: 3,
  },
  cellLabel: { flex: 2, fontSize: 9, color: INK },
  cellValue: { flex: 1, fontSize: 9, color: INK, textAlign: 'right' },
  prompt: {
    marginTop: 14,
    marginBottom: 12,
    textAlign: 'center',
    fontSize: 13,
    fontStyle: 'italic',
  },
  responseZone: { flexGrow: 1, minHeight: 120, marginTop: 8 },
  responseLine: { height: 22, borderBottomWidth: 0.5, borderBottomColor: BORDER },
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

export type WeeklyReflectionPdfInput = {
  period_start: string;
  period_end: string;
  formattedRange: string;
  reflection: WeeklyReflectionOutput;
};

function WeeklyReflectionDoc(props: WeeklyReflectionPdfInput & { qrDataUrl: string }) {
  const { period_start, formattedRange, reflection, qrDataUrl } = props;
  const lineCount = 6;

  return (
    <Document>
      <Page size="LETTER" style={styles.page}>
        <View style={styles.headerBand}>
          <Text style={styles.title}>Weekly Reflection</Text>
          <Text style={styles.subtitle}>{formattedRange}</Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Week in review</Text>
          <Text style={styles.body}>{reflection.week_in_review}</Text>
        </View>

        <View style={styles.columns}>
          <View style={styles.col}>
            {reflection.recurring_people.length > 0 && (
              <View style={styles.section}>
                <Text style={styles.sectionLabel}>Recurring people</Text>
                <Bullets
                  items={reflection.recurring_people.map(
                    (p) => `${p.name || p.email} — ${p.count}× (${p.contexts.join(', ')})`
                  )}
                />
              </View>
            )}
            {reflection.recurring_topics.length > 0 && (
              <View style={styles.section}>
                <Text style={styles.sectionLabel}>Recurring topics</Text>
                <Bullets
                  items={reflection.recurring_topics.map(
                    (t) => `${t.topic} (${t.meeting_refs.length} meetings)`
                  )}
                />
              </View>
            )}
          </View>
          <View style={styles.col}>
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>Action items</Text>
              {reflection.action_items_status.drifting.length > 0 && (
                <>
                  <Text style={[styles.body, { fontFamily: 'Helvetica-Bold', marginTop: 2 }]}>
                    Drifting
                  </Text>
                  <Bullets items={reflection.action_items_status.drifting} />
                </>
              )}
              {reflection.action_items_status.still_open.length > 0 && (
                <>
                  <Text style={[styles.body, { fontFamily: 'Helvetica-Bold', marginTop: 4 }]}>
                    Still open
                  </Text>
                  <Bullets items={reflection.action_items_status.still_open} />
                </>
              )}
              {reflection.action_items_status.closed_this_week.length > 0 && (
                <>
                  <Text style={[styles.body, { fontFamily: 'Helvetica-Bold', marginTop: 4 }]}>
                    Closed
                  </Text>
                  <Bullets items={reflection.action_items_status.closed_this_week} />
                </>
              )}
            </View>
          </View>
        </View>

        {reflection.hubspot_deltas && (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>HubSpot deltas</Text>
            <View style={styles.table}>
              <View style={styles.row}>
                <Text style={styles.cellLabel}>Pipeline change</Text>
                <Text style={styles.cellValue}>{reflection.hubspot_deltas.pipeline_change}</Text>
              </View>
              {reflection.hubspot_deltas.deals_moved.map((d, i) => (
                <View key={`m${i}`} style={styles.row}>
                  <Text style={styles.cellLabel}>Moved: {d}</Text>
                  <Text style={styles.cellValue}></Text>
                </View>
              ))}
              {reflection.hubspot_deltas.deals_gone_cold.map((d, i) => (
                <View key={`c${i}`} style={styles.row}>
                  <Text style={styles.cellLabel}>Cold: {d}</Text>
                  <Text style={styles.cellValue}></Text>
                </View>
              ))}
              {reflection.hubspot_deltas.rep_anomalies.map((r, i) => (
                <View key={`r${i}`} style={styles.row}>
                  <Text style={styles.cellLabel}>{r}</Text>
                  <Text style={styles.cellValue}></Text>
                </View>
              ))}
            </View>
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
          <Text style={styles.dateText}>{period_start}</Text>
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

export async function renderWeeklyReflectionPdf(
  input: WeeklyReflectionPdfInput
): Promise<Buffer> {
  const payload: QrPayload = {
    meetingId: 'reflection-weekly',
    seriesId: 'reflection',
    date: input.period_start,
    version: 1,
  };
  const qrDataUrl = await generateQrDataUrl(payload);
  return renderToBuffer(<WeeklyReflectionDoc {...input} qrDataUrl={qrDataUrl} />);
}

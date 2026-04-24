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
import type { DailyOverviewOutput } from '@/lib/anthropic';

const ACCENT = '#B85C38';
const INK = '#1a1a1a';
const MUTED = '#888';
const FAINT = '#bbb';

const styles = StyleSheet.create({
  page: {
    padding: 28,
    fontSize: 10,
    fontFamily: 'Helvetica',
    color: INK,
    flexDirection: 'column',
  },
  headerBand: {
    borderLeftWidth: 3,
    borderLeftColor: ACCENT,
    paddingLeft: 10,
    marginBottom: 12,
  },
  title: { fontSize: 14, fontFamily: 'Helvetica-Bold' },
  columns: { flexDirection: 'row', flexGrow: 1, gap: 16 },
  left: { width: '40%' },
  right: { width: '60%' },
  sectionLabel: {
    fontSize: 8,
    fontFamily: 'Helvetica-Bold',
    color: MUTED,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  body: { fontSize: 10, lineHeight: 1.4, marginBottom: 12 },
  bullet: { flexDirection: 'row', marginBottom: 2 },
  bulletDot: { width: 10, fontSize: 10 },
  bulletText: { flex: 1, fontSize: 10, lineHeight: 1.35 },
  meetingLine: { fontSize: 9, marginBottom: 3 },
  parkingLotPrompt: { fontSize: 9, color: FAINT, marginBottom: 3, fontStyle: 'italic' },
  parkingCanvas: { flexGrow: 1, marginTop: 10 },
  parkingLine: { height: 22, borderBottomWidth: 0.5, borderBottomColor: '#d4d4d4' },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 10,
  },
  qr: { width: 25, height: 25 },
  dateText: { fontSize: 8, color: MUTED },
});

export type DailyOverviewMeetingRow = {
  title: string;
  startTime: string;
  endTime: string;
  attendeeCount: number;
};

export type DailyOverviewPdfInput = {
  date: string;
  formattedDate: string;
  meetings: DailyOverviewMeetingRow[];
  overview: DailyOverviewOutput;
};

function DailyOverviewDoc(props: DailyOverviewPdfInput & { qrDataUrl: string }) {
  const { date, formattedDate, meetings, overview, qrDataUrl } = props;
  const parkingLineCount = 20;

  return (
    <Document>
      <Page size="LETTER" orientation="landscape" style={styles.page}>
        <View style={styles.headerBand}>
          <Text style={styles.title}>{formattedDate}</Text>
        </View>

        <View style={styles.columns}>
          <View style={styles.left}>
            <Text style={styles.sectionLabel}>Shape of day</Text>
            <Text style={styles.body}>{overview.shape_of_day}</Text>

            {overview.watch_outs.length > 0 && (
              <>
                <Text style={styles.sectionLabel}>Watch-outs</Text>
                <View style={{ marginBottom: 12 }}>
                  {overview.watch_outs.map((w, i) => (
                    <View key={i} style={styles.bullet}>
                      <Text style={styles.bulletDot}>•</Text>
                      <Text style={styles.bulletText}>{w}</Text>
                    </View>
                  ))}
                </View>
              </>
            )}

            <Text style={styles.sectionLabel}>Meetings</Text>
            {meetings.length === 0 ? (
              <Text style={styles.meetingLine}>(none)</Text>
            ) : (
              meetings.map((m, i) => (
                <Text key={i} style={styles.meetingLine}>
                  {m.startTime}–{m.endTime}  {m.title}  ({m.attendeeCount})
                </Text>
              ))
            )}
          </View>

          <View style={styles.right}>
            <Text style={styles.sectionLabel}>Parking lot</Text>
            {overview.parking_lot_prompts.map((p, i) => (
              <Text key={i} style={styles.parkingLotPrompt}>
                {p}
              </Text>
            ))}
            <View style={styles.parkingCanvas}>
              {Array.from({ length: parkingLineCount }).map((_, i) => (
                <View key={i} style={styles.parkingLine} />
              ))}
            </View>
          </View>
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

export async function renderDailyOverviewPdf(input: DailyOverviewPdfInput): Promise<Buffer> {
  const payload: QrPayload = {
    meetingId: 'daily',
    seriesId: 'daily-overview',
    date: input.date,
    version: 1,
  };
  const qrDataUrl = await generateQrDataUrl(payload);
  return renderToBuffer(<DailyOverviewDoc {...input} qrDataUrl={qrDataUrl} />);
}

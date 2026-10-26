/**
 * Daily hadits shown on the login screen. Small curated set; the selection is
 * deterministic per calendar day so every operator sees the same one, and it
 * changes at local midnight. All health/healing themed, sahih sources.
 */

export interface Hadits {
  arabic: string;
  translation: string;
  source: string;
  date: string;
}

const HADITS: ReadonlyArray<Omit<Hadits, 'date'>> = [
  {
    arabic: 'مَا أَنْزَلَ اللّٰهُ دَاءً إِلَّا أَنْزَلَ لَهُ شِفَاءً',
    translation: 'Tidaklah Allah menurunkan suatu penyakit melainkan Dia turunkan pula obatnya.',
    source: 'HR. Bukhari · No. 5678',
  },
  {
    arabic: 'مَنْ نَفَّسَ عَنْ مُؤْمِنٍ كُرْبَةً نَفَّسَ اللّٰهُ عَنْهُ كُرْبَةً مِنْ كُرَبِ يَوْمِ الْقِيَامَةِ',
    translation: 'Barangsiapa meringankan kesulitan seorang mukmin, Allah akan meringankan kesulitannya pada hari kiamat.',
    source: 'HR. Muslim · No. 2699',
  },
  {
    arabic: 'الْمُسْلِمُ مَنْ سَلِمَ الْمُسْلِمُونَ مِنْ لِسَانِهِ وَيَدِهِ',
    translation: 'Muslim adalah orang yang kaum muslimin selamat dari lisan dan tangannya.',
    source: 'HR. Bukhari · No. 10',
  },
  {
    arabic: 'إِنَّ اللّٰهَ يُحِبُّ إِذَا عَمِلَ أَحَدُكُمْ عَمَلًا أَنْ يُتْقِنَهُ',
    translation: 'Sesungguhnya Allah mencintai apabila seseorang mengerjakan sesuatu, ia menyempurnakannya.',
    source: 'HR. Thabrani · No. 891',
  },
  {
    arabic: 'خَيْرُ النَّاسِ أَنْفَعُهُمْ لِلنَّاسِ',
    translation: 'Sebaik-baik manusia adalah yang paling bermanfaat bagi manusia lainnya.',
    source: 'HR. Ahmad · No. 6046',
  },
];

const ID_DATE = new Intl.DateTimeFormat('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });

/** Deterministic day-of-year index so the hadits is stable within a day. */
export function haditsForDate(now: Date = new Date()): Hadits {
  const start = new Date(now.getFullYear(), 0, 0);
  const dayOfYear = Math.floor((now.getTime() - start.getTime()) / 86_400_000);
  const pick = HADITS[dayOfYear % HADITS.length]!;
  return { ...pick, date: ID_DATE.format(now).toUpperCase() };
}

export const dailyHadits = (): Hadits => haditsForDate();

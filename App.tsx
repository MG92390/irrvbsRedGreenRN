import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from 'expo-speech-recognition';
import {
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { getForms, verbLists, verbs, type Verb } from './src/data/verbs';
import {
  addAttempt,
  loadBestScores,
  loadStats,
  saveBestScore,
  saveStats,
  type BestScores,
  type Stats,
} from './src/services/verbStats';

const ROUND_MS = 30_000;
const QUESTION_MS = 5_000;
const FEEDBACK_MS = 2_000;
const COLORS = {
  paper: '#F5F3EB',
  white: '#FFFEFA',
  ink: '#182820',
  muted: '#718078',
  green: '#246B4B',
  lime: '#D8EF72',
  red: '#C43E36',
  line: '#E5E2D8',
  paleGreen: '#E7F0E8',
  paleRed: '#F8E8E4',
};

type RoundAnswer = {
  french: string;
  answer: string;
  correct: string;
  isCorrect: boolean;
  matchedForms: number;
  pointsEarned: number;
  responseMs: number;
};

function shuffle<T>(items: T[]): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function makeDeck(pool: Verb[]): Verb[] {
  const deck: Verb[] = [];
  while (deck.length < 120) deck.push(...shuffle(pool));
  return deck;
}

function recognitionContextFor(verb: Verb | undefined): string[] {
  if (!verb) return [];
  return [verb.base, verb.past, verb.participle]
    .flatMap((form) => form.split('/'))
    .map((form) => form.trim())
    .filter(Boolean);
}

function phoneticKey(word: string): string {
  return word
    .toLocaleLowerCase('en-US')
    .replace(/[aeiou]/g, 'a')
    .replace(/[dt]/g, 't')
    .replace(/[cqk]/g, 'k')
    .replace(/(.)\1+/g, '$1');
}

function isCloseSpokenWord(spoken: string, expected: string): boolean {
  if (spoken === expected) return true;
  const spokenKey = phoneticKey(spoken);
  const expectedKey = phoneticKey(expected);
  if (spokenKey === expectedKey) return true;
  if (Math.abs(spokenKey.length - expectedKey.length) > 1) return false;
  if (Math.min(spokenKey.length, expectedKey.length) < 5) return false;

  let differences = 0;
  let spokenIndex = 0;
  let expectedIndex = 0;
  while (spokenIndex < spokenKey.length && expectedIndex < expectedKey.length) {
    if (spokenKey[spokenIndex] === expectedKey[expectedIndex]) {
      spokenIndex += 1;
      expectedIndex += 1;
    } else {
      differences += 1;
      if (differences > 1) return false;
      if (spokenKey.length > expectedKey.length) spokenIndex += 1;
      else if (expectedKey.length > spokenKey.length) expectedIndex += 1;
      else {
        spokenIndex += 1;
        expectedIndex += 1;
      }
    }
  }

  return differences + (spokenIndex < spokenKey.length || expectedIndex < expectedKey.length ? 1 : 0) <= 1;
}

function matchedFormsInTranscript(transcript: string, verb: Verb): number {
  const words = (value: string) =>
    value
      .toLocaleLowerCase('en-US')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean);
  const spokenWords = words(transcript);
  let nextWordIndex = 0;

  let matchedForms = 0;
  for (const form of [verb.base, verb.past, verb.participle]) {
    const alternatives = form.split('/').map((alternative) => words(alternative.trim()));
    let match: { index: number; length: number } | undefined;

    for (let index = nextWordIndex; index < spokenWords.length && !match; index += 1) {
      for (const alternative of alternatives) {
        if (alternative.every((word, offset) => {
          const spokenWord = spokenWords[index + offset];
          return spokenWord !== undefined && isCloseSpokenWord(spokenWord, word);
        })) {
          match = { index, length: alternative.length };
          break;
        }
      }
    }

    if (!match) break;
    matchedForms += 1;
    nextWordIndex = match.index + match.length;
  }

  return matchedForms;
}

function formatTime(milliseconds: number): string {
  return `${(milliseconds / 1000).toFixed(2).replace('.', ',')} s`;
}

function pointsFor(milliseconds: number): number {
  if (milliseconds < 1000) return 5;
  if (milliseconds < 1200) return 3;
  if (milliseconds < 1400) return 2;
  if (milliseconds <= 5000) return 1;
  return 0;
}

function listName(id: number): string {
  return verbLists.find((list) => list.id === id)?.title ?? '';
}

export default function App() {
  const [screen, setScreen] = useState<'home' | 'quiz' | 'revision' | 'result'>('home');
  const [selectedList, setSelectedList] = useState(1);
  const [stats, setStats] = useState<Stats>({});
  const [bestScores, setBestScores] = useState<BestScores>({});
  const [deck, setDeck] = useState<Verb[]>([]);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [remainingMs, setRemainingMs] = useState(ROUND_MS);
  const [questionRemainingMs, setQuestionRemainingMs] = useState(QUESTION_MS);
  const [score, setScore] = useState(0);
  const [answeredCount, setAnsweredCount] = useState(0);
  const [correctCount, setCorrectCount] = useState(0);
  const [roundAnswers, setRoundAnswers] = useState<RoundAnswer[]>([]);
  const [feedback, setFeedback] = useState<'correct' | 'partial' | 'wrong' | null>(null);
  const [transcript, setTranscript] = useState('');
  const [isListening, setIsListening] = useState(false);
  const [speechPermissionGranted, setSpeechPermissionGranted] = useState(false);
  const [speechError, setSpeechError] = useState('');
  const statsRef = useRef<Stats>({});
  const startedAt = useRef(0);
  const roundEndsAt = useRef(0);
  const transcriptRef = useRef('');
  const finalTranscriptRef = useRef('');
  const answered = useRef(false);
  const roundFinished = useRef(false);
  const advanceQuestion = useRef<() => void>(() => undefined);
  const finishRound = useRef<() => void>(() => undefined);
  const currentVerb = deck[questionIndex];
  const currentVerbRef = useRef<Verb | undefined>(currentVerb);

  useSpeechRecognitionEvent('start', () => {
    setIsListening(true);
    setSpeechError('');
  });
  useSpeechRecognitionEvent('end', () => setIsListening(false));
  useSpeechRecognitionEvent('error', (event) => {
    setIsListening(false);
    if (event.error !== 'aborted' && event.error !== 'no-speech') {
      setSpeechError('La reconnaissance vocale est indisponible. Vérifie les autorisations et le service vocal du téléphone.');
    }
  });
  useSpeechRecognitionEvent('result', (event) => {
    const segment = event.results[0]?.transcript ?? '';
    const recognized = [finalTranscriptRef.current, segment].filter(Boolean).join(' ');
    if (event.isFinal) finalTranscriptRef.current = recognized;
    transcriptRef.current = recognized;
    setTranscript(recognized);
    if (screen !== 'quiz' || answered.current || !currentVerbRef.current || Date.now() >= roundEndsAt.current) return;

    const responseMs = Date.now() - startedAt.current;
    if (responseMs > QUESTION_MS) return;
    const verb = currentVerbRef.current;
    const matchedForms = matchedFormsInTranscript(recognized, verb);
    if (matchedForms < 3) return;

    answered.current = true;
    ExpoSpeechRecognitionModule.abort();
    setAnsweredCount((count) => count + 1);
    const pointsEarned = pointsFor(responseMs);
    setCorrectCount((count) => count + 1);
    setScore((current) => current + pointsEarned);
    setRoundAnswers((current) => [
      ...current,
      {
        french: verb.french,
        answer: getForms(verb),
        correct: getForms(verb),
        isCorrect: true,
        matchedForms,
        pointsEarned,
        responseMs,
      },
    ]);
    setFeedback('correct');
    recordAttempt(verb, true, responseMs);
    advanceQuestion.current();
  });

  useEffect(() => {
    loadStats().then((saved) => {
      statsRef.current = saved;
      setStats(saved);
    });
    loadBestScores().then(setBestScores);
  }, []);

  function recordAttempt(verb: Verb, correct: boolean, responseMs: number | null) {
    const updated = addAttempt(statsRef.current, verb.id, correct, responseMs);
    statsRef.current = updated;
    setStats(updated);
    saveStats(updated).catch(() => undefined);
  }

  useEffect(() => {
    if (screen !== 'quiz') return;
    const interval = setInterval(() => {
      const timeLeft = Math.max(0, roundEndsAt.current - Date.now());
      setRemainingMs(timeLeft);
      const questionTimeLeft = Math.max(0, QUESTION_MS - (Date.now() - startedAt.current));
      setQuestionRemainingMs(questionTimeLeft);
      if (timeLeft === 0) finishRound.current();
      else if (!answered.current && questionTimeLeft === 0) {
        answered.current = true;
        ExpoSpeechRecognitionModule.abort();
        const missedVerb = deck[questionIndex];
        if (missedVerb) {
          const matchedForms = matchedFormsInTranscript(transcriptRef.current, missedVerb);
          const pointsEarned = matchedForms;
          if (pointsEarned > 0) setScore((current) => current + pointsEarned);
          setRoundAnswers((current) => [
            ...current,
            {
              french: missedVerb.french,
              answer: transcriptRef.current || 'Pas de réponse',
              correct: getForms(missedVerb),
              isCorrect: false,
              matchedForms,
              pointsEarned,
              responseMs: QUESTION_MS,
            },
          ]);
          setAnsweredCount((count) => count + 1);
          recordAttempt(missedVerb, false, transcriptRef.current ? QUESTION_MS : null);
          setFeedback(pointsEarned > 0 ? 'partial' : 'wrong');
          advanceQuestion.current();
        }
      }
    }, 50);
    return () => clearInterval(interval);
  }, [screen, deck, questionIndex]);

  useEffect(() => {
    if (!feedback) return;
    const timeout = setTimeout(() => setFeedback(null), FEEDBACK_MS);
    return () => clearTimeout(timeout);
  }, [feedback]);

  useEffect(() => {
    if (screen !== 'quiz' || !speechPermissionGranted || roundFinished.current) return;

    try {
      ExpoSpeechRecognitionModule.start({
        lang: 'en-US',
        interimResults: true,
        continuous: true,
        maxAlternatives: 1,
        contextualStrings: recognitionContextFor(currentVerb),
        androidIntentOptions: { EXTRA_LANGUAGE_MODEL: 'web_search' },
      });
    } catch {
      setTimeout(() => setSpeechError('Impossible de démarrer la reconnaissance vocale sur cet appareil.'), 0);
    }

    return () => {
      ExpoSpeechRecognitionModule.abort();
    };
  }, [screen, questionIndex, speechPermissionGranted]);

  function showQuestion(index: number, questionDeck: Verb[]) {
    setQuestionIndex(index);
    currentVerbRef.current = questionDeck[index];
    startedAt.current = Date.now();
    transcriptRef.current = '';
    finalTranscriptRef.current = '';
    setTranscript('');
    setQuestionRemainingMs(QUESTION_MS);
    answered.current = false;
  }

  async function startRound(listId: number) {
    if (!ExpoSpeechRecognitionModule.isRecognitionAvailable()) {
      setSpeechError('La reconnaissance vocale anglaise n’est pas disponible sur cet appareil.');
      return;
    }
    const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!permission.granted) {
      setSpeechError('Autorise l’accès au microphone et à la reconnaissance vocale pour jouer à l’oral.');
      return;
    }
    setSpeechPermissionGranted(true);
    setSpeechError('');
    const pool = verbs.filter((verb) => verb.list === listId);
    const nextDeck = makeDeck(pool);
    setSelectedList(listId);
    setDeck(nextDeck);
    setScore(0);
    setAnsweredCount(0);
    setCorrectCount(0);
    setRoundAnswers([]);
    setRemainingMs(ROUND_MS);
    setQuestionRemainingMs(QUESTION_MS);
    transcriptRef.current = '';
    finalTranscriptRef.current = '';
    setTranscript('');
    setFeedback(null);
    roundFinished.current = false;
    roundEndsAt.current = Date.now() + ROUND_MS;
    setScreen('quiz');
    showQuestion(0, nextDeck);
  }

  advanceQuestion.current = () => {
    if (Date.now() >= roundEndsAt.current) {
      finishRound.current();
      return;
    }
    const nextIndex = questionIndex + 1;
    if (nextIndex >= deck.length) {
      finishRound.current();
      return;
    }
    showQuestion(nextIndex, deck);
  };

  finishRound.current = () => {
    if (roundFinished.current) return;
    roundFinished.current = true;
    setRemainingMs(0);
    setScreen('result');
    saveBestScore(selectedList, score).then(setBestScores).catch(() => undefined);
  };

  const progress = 1 - remainingMs / ROUND_MS;
  const questionProgress = 1 - questionRemainingMs / QUESTION_MS;
  const listVerbs = verbs.filter((verb) => verb.list === selectedList);
  const meanTime = (verb: Verb) => {
    const stat = stats[verb.id];
    return stat?.responseCount ? stat.responseMsTotal / stat.responseCount : null;
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />
      {screen === 'home' && (
        <ScrollView contentContainerStyle={styles.homeContent} showsVerticalScrollIndicator={false}>
          <View style={styles.topline}>
            <Text style={styles.brand}>VERB CLUB</Text>
            <View style={styles.languageTag}><Text style={styles.languageText}>EN · FR</Text></View>
          </View>
          <View style={styles.hero}>
            <Text style={styles.eyebrow}>TON RENDEZ-VOUS ANGLAIS</Text>
            <Text style={styles.heroTitle}>Les verbes{ '\n' }irréguliers.</Text>
            <View style={styles.heroBottom}>
              <Text style={styles.heroCopy}>Une manche. 30 secondes.{ '\n' }À toi de jouer.</Text>
              <View style={styles.heroStamp}><Text style={styles.heroStampNumber}>10</Text><Text style={styles.heroStampLabel}>LISTES</Text></View>
            </View>
          </View>

          <View style={styles.sectionHeading}>
            <View><Text style={styles.sectionTitle}>Choisis ta liste</Text><Text style={styles.sectionSubtitle}>Sélectionne une liste pour voir tes verbes.</Text></View>
          </View>

          <View style={styles.listGrid}>
            {verbLists.map((list) => {
              const active = selectedList === list.id;
              return (
                <Pressable
                  key={list.id}
                  onPress={() => {
                    if (active) startRound(list.id);
                    else setSelectedList(list.id);
                  }}
                  style={[styles.listCard, active && styles.listCardActive]}
                >
                  <View style={styles.listCardTop}>
                    <Text style={[styles.listNumber, active && styles.listNumberActive]}>{String(list.id).padStart(2, '0')}</Text>
                    <Text style={[styles.listArrow, active && styles.listTitleActive]}>↗</Text>
                  </View>
                  <Text style={[styles.listTitle, active && styles.listTitleActive]}>{list.title}</Text>
                  <View style={styles.listScores}>
                    <View style={styles.listScore}><Text style={styles.listScoreLabel}>ATTENDU</Text><Text style={styles.listScoreValue}>{list.expectedScore ?? '—'}</Text></View>
                    <View style={styles.listScore}><Text style={[styles.listScoreLabel, styles.personalRecordLabel]}>TON RECORD</Text><Text style={styles.listScoreValue}>{bestScores[list.id] ?? '—'}</Text></View>
                    <View style={styles.listScore}><Text style={styles.listScoreLabel}>CLASSEMENT</Text><Text style={styles.listScoreValue}>—</Text></View>
                  </View>
                </Pressable>
              );
            })}
          </View>

          {speechError !== '' && <Text style={styles.speechError}>{speechError}</Text>}
          <Pressable style={styles.startButton} onPress={() => startRound(selectedList)}>
            <Text style={styles.startButtonText}>Démarrer le mode oral · liste {String(selectedList).padStart(2, '0')}</Text>
            <Text style={styles.startButtonArrow}>→</Text>
          </Pressable>
          <Pressable style={styles.secondaryButton} onPress={() => setScreen('revision')}>
            <Text style={styles.secondaryButtonText}>Réviser les verbes</Text>
          </Pressable>

          <View style={styles.statsSection}>
            <View style={styles.sectionHeading}>
              <View><Text style={styles.sectionTitle}>Tes réflexes</Text><Text style={styles.sectionSubtitle}>Temps moyen et réussite par verbe</Text></View>
            </View>
            {listVerbs.map((verb) => {
              const stat = stats[verb.id];
              const average = meanTime(verb);
              return (
                <View key={verb.id} style={styles.verbStatRow}>
                  <View style={styles.verbStatName}><Text style={styles.verbStatFrench}>{verb.french}</Text><Text style={styles.verbStatEnglish}>{verb.base}</Text></View>
                  <Text style={styles.verbStatAverage}>{average === null ? '—' : formatTime(average)}</Text>
                  <Text style={styles.verbStatAccuracy}>{stat?.attempts ? `${Math.round((stat.correct / stat.attempts) * 100)}%` : '—'}</Text>
                </View>
              );
            })}
          </View>

          <Text style={styles.footerText}>30 SECONDES · RÉPONSES ORALES EN ANGLAIS</Text>
        </ScrollView>
      )}

      {screen === 'quiz' && currentVerb && (
        <View style={styles.quizScreen}>
          <View style={styles.quizHeader}>
            <Pressable style={styles.backButton} onPress={() => setScreen('home')}><Text style={styles.backGlyph}>‹</Text></Pressable>
            <View style={styles.quizHeaderLabel}><Text style={styles.brand}>MODE ORAL · LISTE {String(selectedList).padStart(2, '0')}</Text><Text style={styles.quizSubhead}>{listName(selectedList)}</Text></View>
          </View>
          <View style={styles.progressTrack}><View style={[styles.progressFill, { width: `${Math.min(100, progress * 100)}%` }]} /></View>
          <View style={styles.quizMeta}><Text style={styles.quizMetaLabel}>QUESTION {String(questionIndex + 1).padStart(2, '0')}</Text><Text style={styles.quizScore}>{score} PTS</Text></View>
          <View style={styles.quizBody}>
            <View style={styles.questionBlock}>
              <Text style={styles.questionPrompt}>Comment dit-on</Text>
              <Text style={styles.questionWord}>{currentVerb.french}</Text>
              <Text style={styles.questionHint}>en anglais ? Donne les trois formes.</Text>
            </View>
            <View style={styles.voiceAnswer}>
              <View style={[styles.microphoneMark, isListening && styles.microphoneMarkActive]}>
                <Text style={styles.microphoneGlyph}>●</Text>
              </View>
              <Text style={styles.voiceStatus}>{isListening ? 'À toi de parler' : 'Préparation du micro…'}</Text>
              <Text style={styles.voiceInstruction}>Base verbale · prétérit · participe passé</Text>
              <View style={styles.questionProgressTrack}>
                <View style={[styles.questionProgressFill, { width: `${Math.min(100, questionProgress * 100)}%` }]} />
              </View>
              <Text style={styles.transcriptText}>{transcript || 'La transcription apparaîtra ici'}</Text>
            </View>
            {speechError !== '' && <Text style={styles.speechError}>{speechError}</Text>}
          </View>
          <View style={styles.quizFooter}><Text style={styles.quizFooterLabel}>BARÈME</Text><Text style={styles.pointsLegend}>‹1s  +5  ·  ‹1,2s  +3  ·  ‹1,4s  +2  ·  ‹5s  +1</Text></View>
        </View>
      )}

      {screen === 'revision' && (
        <ScrollView contentContainerStyle={styles.revisionScreen} showsVerticalScrollIndicator={false}>
          <View style={styles.revisionHeader}>
            <Pressable style={styles.backButton} onPress={() => setScreen('home')}><Text style={styles.backGlyph}>‹</Text></Pressable>
            <View style={styles.quizHeaderLabel}>
              <Text style={styles.brand}>RÉVISION · LISTE {String(selectedList).padStart(2, '0')}</Text>
              <Text style={styles.quizSubhead}>{listName(selectedList)}</Text>
            </View>
          </View>
          <Text style={styles.revisionTitle}>Les verbes</Text>
          <View style={styles.revisionTable}>
            <View style={[styles.revisionTableRow, styles.revisionTableHeader]}>
              <View style={[styles.revisionCell, styles.revisionFrenchCell]}><Text style={styles.revisionHeaderText}>TRADUCTION</Text></View>
              <View style={[styles.revisionCell, styles.revisionVerbCell]}><Text style={styles.revisionHeaderText}>BASE{ '\n' }VERBALE</Text></View>
              <View style={[styles.revisionCell, styles.revisionVerbCell]}><Text style={styles.revisionHeaderText}>PRÉTÉRIT</Text></View>
              <View style={[styles.revisionCell, styles.revisionVerbCell, styles.revisionLastCell]}><Text style={styles.revisionHeaderText}>PARTICIPE{ '\n' }PASSÉ</Text></View>
            </View>
            {listVerbs.map((verb, index) => (
              <View key={verb.id} style={[styles.revisionTableRow, index % 2 === 1 && styles.revisionAlternateRow]}>
                <View style={[styles.revisionCell, styles.revisionFrenchCell]}><Text style={styles.revisionFrench}>{verb.french}</Text></View>
                <View style={[styles.revisionCell, styles.revisionVerbCell]}><Text style={styles.revisionForm}>{verb.base}</Text></View>
                <View style={[styles.revisionCell, styles.revisionVerbCell]}><Text style={styles.revisionForm}>{verb.past}</Text></View>
                <View style={[styles.revisionCell, styles.revisionVerbCell, styles.revisionLastCell]}><Text style={styles.revisionForm}>{verb.participle}</Text></View>
              </View>
            ))}
          </View>
        </ScrollView>
      )}

      {screen === 'result' && (
        <ScrollView contentContainerStyle={styles.resultScreen} showsVerticalScrollIndicator={false}>
          <Text style={styles.eyebrow}>FIN DE LA MANCHE · LISTE {String(selectedList).padStart(2, '0')}</Text>
          <Text style={styles.resultTitle}>Bien joué.{ '\n' }On débriefe ?</Text>
          <View style={styles.resultScore}><Text style={styles.resultScoreNumber}>{score}</Text><Text style={styles.resultScoreLabel}>POINTS</Text></View>
          <View style={styles.resultMetrics}>
            <View style={styles.resultMetric}><Text style={styles.resultMetricValue}>{correctCount}/{answeredCount}</Text><Text style={styles.resultMetricLabel}>BONNES RÉPONSES</Text></View>
            <View style={styles.resultMetric}><Text style={styles.resultMetricValue}>{answeredCount ? `${Math.round((correctCount / answeredCount) * 100)}%` : '0%'}</Text><Text style={styles.resultMetricLabel}>DE RÉUSSITE</Text></View>
          </View>
          {roundAnswers.length > 0 && <View style={styles.reviewBlock}><Text style={styles.reviewTitle}>Tes réponses</Text>{roundAnswers.map((answer, index) => <View key={`${answer.french}-${index}`} style={styles.reviewRow}><Text style={styles.reviewFrench}>{answer.french}</Text><Text style={[styles.reviewAnswer, answer.answer.trim().toLocaleLowerCase('fr-FR') !== 'pas de réponse' && answer.matchedForms > 0 ? styles.correctAnswer : styles.incorrectAnswer]}>Ta réponse : {answer.answer}</Text><Text style={styles.reviewForms}>Temps : {answer.responseMs} ms</Text>{!answer.isCorrect && <Text style={styles.reviewForms}>{answer.matchedForms}/3 formes reconnues · +{answer.pointsEarned} pt{answer.pointsEarned === 1 ? '' : 's'} · attendu : {answer.correct}</Text>}</View>)}</View>}
          <Pressable style={styles.startButton} onPress={() => startRound(selectedList)}><Text style={styles.startButtonText}>Rejouer cette liste</Text><Text style={styles.startButtonArrow}>↻</Text></Pressable>
          <Pressable style={styles.secondaryButton} onPress={() => setScreen('home')}><Text style={styles.secondaryButtonText}>Choisir une autre liste</Text></Pressable>
        </ScrollView>
      )}

      {feedback && (
        <View pointerEvents="none" style={[styles.feedbackToast, feedback === 'correct' ? styles.feedbackCorrect : feedback === 'partial' ? styles.feedbackPartial : styles.feedbackWrong]}>
          <Text style={[styles.feedbackIcon, feedback === 'partial' && styles.feedbackPartialText]}>{feedback === 'correct' ? '✓' : feedback === 'partial' ? '+' : '×'}</Text>
          <Text style={[styles.feedbackText, feedback === 'partial' && styles.feedbackPartialText]}>{feedback === 'correct' ? 'Exact !' : feedback === 'partial' ? 'Crédit partiel' : 'À revoir'}</Text>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: COLORS.paper },
  homeContent: { paddingHorizontal: 22, paddingTop: 12, paddingBottom: 32 },
  topline: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8 },
  brand: { color: COLORS.green, fontSize: 11, fontWeight: '900', letterSpacing: 1.5 },
  languageTag: { borderWidth: 1, borderColor: COLORS.line, paddingHorizontal: 10, paddingVertical: 6 },
  languageText: { color: COLORS.ink, fontSize: 10, fontWeight: '800' },
  hero: { marginTop: 18, padding: 22, minHeight: 218, backgroundColor: COLORS.green, justifyContent: 'space-between' },
  eyebrow: { color: COLORS.lime, fontSize: 10, fontWeight: '900', letterSpacing: 1.6 },
  heroTitle: { marginTop: 13, color: COLORS.white, fontSize: 38, lineHeight: 41, fontWeight: '900' },
  heroBottom: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', marginTop: 16 },
  heroCopy: { color: '#DCE9DD', fontSize: 13, lineHeight: 19 },
  heroStamp: { width: 62, height: 62, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.lime },
  heroStampNumber: { color: COLORS.ink, fontSize: 25, lineHeight: 27, fontWeight: '900' },
  heroStampLabel: { color: COLORS.ink, fontSize: 8, fontWeight: '900', letterSpacing: 1 },
  sectionHeading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 27, marginBottom: 13 },
  sectionTitle: { color: COLORS.ink, fontSize: 21, fontWeight: '900' },
  sectionSubtitle: { marginTop: 4, color: COLORS.muted, fontSize: 11 },
  listGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: 10 },
  listCard: { width: '48.4%', minHeight: 144, padding: 12, backgroundColor: COLORS.white, borderWidth: 1, borderColor: COLORS.line, justifyContent: 'space-between' },
  listCardActive: { backgroundColor: COLORS.lime, borderColor: COLORS.lime },
  listCardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  listNumber: { color: COLORS.green, fontSize: 22, fontWeight: '900' },
  listNumberActive: { color: COLORS.ink },
  listTitle: { marginTop: 8, color: COLORS.ink, fontSize: 13, lineHeight: 17, fontWeight: '800' },
  listTitleActive: { color: COLORS.ink },
  listScores: { flexDirection: 'row', marginTop: 12, paddingTop: 9, borderTopWidth: 1, borderTopColor: COLORS.line },
  listScore: { flex: 1 },
  listScoreLabel: { color: COLORS.muted, fontSize: 7, fontWeight: '900' },
  personalRecordLabel: { marginLeft: -3 },
  listScoreValue: { marginTop: 3, color: COLORS.ink, fontSize: 14, fontWeight: '900' },
  listArrow: { color: COLORS.green, fontSize: 16, fontWeight: '900' },
  statsSection: { marginTop: 12 },
  verbStatRow: { minHeight: 48, flexDirection: 'row', alignItems: 'center', borderTopWidth: 1, borderTopColor: COLORS.line },
  verbStatName: { flex: 1 },
  verbStatFrench: { color: COLORS.ink, fontSize: 13, fontWeight: '700' },
  verbStatEnglish: { marginTop: 2, color: COLORS.muted, fontSize: 10 },
  verbStatAverage: { width: 72, textAlign: 'right', color: COLORS.green, fontSize: 12, fontWeight: '800' },
  verbStatAccuracy: { width: 54, textAlign: 'right', color: COLORS.muted, fontSize: 11, fontWeight: '700' },
  startButton: { minHeight: 56, marginTop: 20, paddingHorizontal: 18, backgroundColor: COLORS.ink, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  startButtonText: { color: COLORS.white, fontSize: 14, fontWeight: '800' },
  startButtonArrow: { color: COLORS.lime, fontSize: 22, fontWeight: '700' },
  footerText: { marginTop: 13, textAlign: 'center', color: COLORS.muted, fontSize: 8, fontWeight: '800', letterSpacing: 0.8 },
  quizScreen: { flex: 1, paddingHorizontal: 22, paddingTop: 10, paddingBottom: 22 },
  quizHeader: { flexDirection: 'row', alignItems: 'center', minHeight: 60 },
  backButton: { width: 42, height: 42, borderWidth: 1, borderColor: COLORS.line, alignItems: 'center', justifyContent: 'center' },
  backGlyph: { marginTop: -4, color: COLORS.ink, fontSize: 32, lineHeight: 36 },
  quizHeaderLabel: { flex: 1, marginLeft: 12 },
  quizSubhead: { marginTop: 3, color: COLORS.muted, fontSize: 11 },
  progressTrack: { height: 4, marginTop: 11, backgroundColor: COLORS.line },
  progressFill: { height: 4, backgroundColor: COLORS.green },
  quizMeta: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 25 },
  quizMetaLabel: { color: COLORS.muted, fontSize: 10, fontWeight: '900', letterSpacing: 1 },
  quizScore: { color: COLORS.green, fontSize: 10, fontWeight: '900', letterSpacing: 1 },
  quizBody: { flex: 1, width: '100%', maxWidth: 520, alignSelf: 'center', justifyContent: 'center' },
  questionBlock: { minHeight: 148, justifyContent: 'center', alignItems: 'center' },
  questionPrompt: { color: COLORS.muted, fontSize: 16 },
  questionWord: { width: '100%', marginTop: 5, color: COLORS.ink, fontSize: 36, lineHeight: 43, fontWeight: '900', textAlign: 'center' },
  questionHint: { marginTop: 4, color: COLORS.green, fontSize: 15, fontWeight: '700' },
  voiceAnswer: { marginHorizontal: 8, marginTop: 18, padding: 20, alignItems: 'center', backgroundColor: COLORS.white, borderWidth: 1, borderColor: COLORS.line },
  microphoneMark: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 22, backgroundColor: COLORS.paleGreen },
  microphoneMarkActive: { backgroundColor: COLORS.lime },
  microphoneGlyph: { color: COLORS.green, fontSize: 17 },
  voiceStatus: { marginTop: 11, color: COLORS.ink, fontSize: 16, fontWeight: '900' },
  voiceInstruction: { marginTop: 5, color: COLORS.muted, fontSize: 11, textAlign: 'center' },
  questionProgressTrack: { width: '100%', height: 4, marginTop: 17, backgroundColor: COLORS.line },
  questionProgressFill: { height: 4, backgroundColor: COLORS.green },
  transcriptText: { minHeight: 38, marginTop: 12, color: COLORS.green, fontSize: 14, fontWeight: '700', textAlign: 'center', textAlignVertical: 'center' },
  speechError: { marginTop: 12, color: COLORS.red, fontSize: 12, lineHeight: 17 },
  quizFooter: { marginTop: 18, alignItems: 'center' },
  quizFooterLabel: { color: COLORS.muted, fontSize: 8, fontWeight: '900', letterSpacing: 1.2 },
  pointsLegend: { marginTop: 7, color: COLORS.ink, fontSize: 9, fontWeight: '700' },
  feedbackToast: { position: 'absolute', bottom: 24, left: 22, right: 22, minHeight: 54, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9 },
  feedbackCorrect: { backgroundColor: COLORS.green },
  feedbackPartial: { backgroundColor: COLORS.lime },
  feedbackWrong: { backgroundColor: COLORS.red },
  feedbackIcon: { color: COLORS.white, fontSize: 25, fontWeight: '900' },
  feedbackText: { color: COLORS.white, fontSize: 14, fontWeight: '800' },
  feedbackPartialText: { color: COLORS.ink },
  resultScreen: { flexGrow: 1, paddingHorizontal: 22, paddingTop: 36, paddingBottom: 32 },
  resultTitle: { marginTop: 14, color: COLORS.ink, fontSize: 38, lineHeight: 41, fontWeight: '900' },
  resultScore: { width: 132, height: 132, marginTop: 25, backgroundColor: COLORS.lime, alignItems: 'center', justifyContent: 'center' },
  resultScoreNumber: { color: COLORS.ink, fontSize: 53, lineHeight: 58, fontWeight: '900' },
  resultScoreLabel: { color: COLORS.ink, fontSize: 9, fontWeight: '900', letterSpacing: 1.5 },
  resultMetrics: { flexDirection: 'row', gap: 10, marginTop: 20 },
  resultMetric: { flex: 1, minHeight: 73, padding: 13, backgroundColor: COLORS.white, borderWidth: 1, borderColor: COLORS.line },
  resultMetricValue: { color: COLORS.green, fontSize: 21, fontWeight: '900' },
  resultMetricLabel: { marginTop: 4, color: COLORS.muted, fontSize: 8, fontWeight: '900', letterSpacing: 0.7 },
  reviewBlock: { marginTop: 25 },
  reviewTitle: { marginBottom: 9, color: COLORS.ink, fontSize: 19, fontWeight: '900' },
  reviewRow: { paddingVertical: 9, borderTopWidth: 1, borderTopColor: COLORS.line },
  reviewFrench: { color: COLORS.red, fontSize: 12, fontWeight: '800' },
  reviewAnswer: { marginTop: 4, color: COLORS.muted, fontSize: 11 },
  correctAnswer: { color: COLORS.green, fontWeight: '800' },
  incorrectAnswer: { color: COLORS.red, fontWeight: '800' },
  reviewForms: { marginTop: 4, color: COLORS.ink, fontSize: 12 },
  secondaryButton: { minHeight: 50, marginTop: 9, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: COLORS.line },
  secondaryButtonText: { color: COLORS.ink, fontSize: 13, fontWeight: '800' },
  revisionScreen: { flexGrow: 1, paddingHorizontal: 22, paddingTop: 12, paddingBottom: 32 },
  revisionHeader: { flexDirection: 'row', alignItems: 'center', minHeight: 60 },
  revisionTitle: { marginTop: 25, marginBottom: 16, color: COLORS.ink, fontSize: 28, fontWeight: '900' },
  revisionTable: { width: '100%', borderWidth: 1, borderColor: COLORS.line, backgroundColor: COLORS.white },
  revisionTableRow: { minHeight: 48, flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: COLORS.line },
  revisionTableHeader: { minHeight: 52, backgroundColor: COLORS.green, borderBottomWidth: 0 },
  revisionAlternateRow: { backgroundColor: '#F0F2EB' },
  revisionCell: { paddingHorizontal: 6, paddingVertical: 10, justifyContent: 'center', borderRightWidth: 1, borderRightColor: COLORS.line },
  revisionFrenchCell: { width: '28%' },
  revisionVerbCell: { width: '24%' },
  revisionLastCell: { borderRightWidth: 0 },
  revisionHeaderText: { color: COLORS.white, fontSize: 8, lineHeight: 11, fontWeight: '900', textAlign: 'left' },
  revisionFrench: { color: COLORS.green, fontSize: 12, lineHeight: 16, fontWeight: '800' },
  revisionForm: { color: COLORS.ink, fontSize: 12, lineHeight: 16, fontWeight: '600' },
});

import { useCallback, useEffect, useRef, useState } from 'react';
import { Maximize2, Minimize2, Pause, Play, RotateCcw, Upload } from 'lucide-react';
import { createScene, POS_LIMIT } from '@/scene';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

type SliceState = { az: number; el: number; pos: number; normal: [number, number, number] };
type SceneApi = ReturnType<typeof createScene>;

const PRESETS = [
  { label: 'Frame', hint: 'XY', az: 0, el: 0 },
  { label: 'Side', hint: 'YT', az: 90, el: 0 },
  { label: 'Top', hint: 'XT', az: 0, el: 90 },
  { label: 'Diagonal', hint: '', az: 35, el: 25 },
];
const MODES = [
  { value: 'loop', label: 'Loop' },
  { value: 'pingpong', label: 'Ping-pong' },
];

const first = (v: number | readonly number[]) => (Array.isArray(v) ? v[0] : (v as number));

/** Number input that lets you type freely and commits (clamped) on every valid keystroke. */
function NumField({ value, min, max, step, decimals, suffix, onCommit }: {
  value: number; min: number; max: number; step: number; decimals: number; suffix?: string;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <div className="flex items-center gap-1 text-sm text-muted-foreground">
      <Input
        type="number"
        className="h-9 w-[5.25rem] px-2.5 text-right text-sm font-medium tabular-nums text-foreground"
        min={min} max={max} step={step}
        value={draft ?? value.toFixed(decimals)}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => {
          setDraft(e.target.value);
          const v = parseFloat(e.target.value);
          if (!Number.isNaN(v)) onCommit(Math.min(max, Math.max(min, v)));
        }}
        onBlur={() => setDraft(null)}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') e.currentTarget.blur(); }}
      />
      {suffix && <span className="w-2.5">{suffix}</span>}
    </div>
  );
}

function Field({ label, htmlFor, right, children }: { label: string; htmlFor?: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <div className="flex min-h-9 items-center justify-between">
        <Label htmlFor={htmlFor} className="text-sm font-medium">{label}</Label>
        {right}
      </div>
      {children}
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <Card className="gap-5">
      <CardHeader>
        <CardTitle className="text-base font-semibold tracking-tight">{title}</CardTitle>
        {hint && <p className="text-sm text-muted-foreground">{hint}</p>}
      </CardHeader>
      <CardContent className="space-y-5">{children}</CardContent>
    </Card>
  );
}

const valueCls = 'text-sm font-medium tabular-nums';

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const sceneRef = useRef<SceneApi | null>(null);

  const [slice, setSlice] = useState<SliceState>({ az: 0, el: 0, pos: 0, normal: [0, 0, 1] });
  const [focused, setFocused] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [mode, setMode] = useState('loop');
  const [speed, setSpeed] = useState(1);
  const [stackOpacity, setStackOpacity] = useState(0.18);
  const [stackCount, setStackCount] = useState(26);
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const api = createScene(canvasRef.current!, stageRef.current!, {
      onSlice: setSlice, onFocus: setFocused, onPlaying: setPlaying,
      onProgress: setProgress, onLoading: setLoading, onError: setError,
    });
    sceneRef.current = api;
    api.load('/video.mp4', 'video.mp4');
    return () => api.dispose();
  }, []);

  const scene = () => sceneRef.current!;

  // keyboard: Space = play/pause, F = full view, Esc = back to volume
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA';
      if (e.key === 'Escape') scene().setFocus(false);
      else if (typing) return;
      else if (e.key.toLowerCase() === 'f') scene().toggleFocus();
      else if (e.code === 'Space' && t.tagName !== 'BUTTON' && t.getAttribute('role') !== 'combobox') {
        e.preventDefault();
        scene().togglePlaying();
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  const onFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setError(null);
    scene().load(URL.createObjectURL(f), f.name);
    e.target.value = '';
  }, []);

  const n = slice.normal;

  return (
    <div className="flex h-dvh w-full flex-col bg-background text-foreground md:flex-row">
      {/* ───── stage ───── */}
      <div ref={stageRef} className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-background">
        <canvas ref={canvasRef} className="block h-full w-full" />

        <div className="pointer-events-none absolute inset-x-0 bottom-5 flex justify-center gap-3 px-4">
          <Button size="lg" className="pointer-events-auto min-w-32 shadow-lg" onClick={() => scene().togglePlaying()} title="Space">
            {playing ? <Pause /> : <Play />} {playing ? 'Pause' : 'Play'}
          </Button>
          <Button size="lg" className="pointer-events-auto min-w-36 shadow-lg" onClick={() => scene().toggleFocus()} title="F or double-click the slice">
            {focused ? <Minimize2 /> : <Maximize2 />} {focused ? 'Exit full view' : 'Full view'}
          </Button>
        </div>

        {(loading || error) && (
          <div className="absolute inset-0 grid place-content-center bg-background/85 backdrop-blur-sm">
            <div className="w-80 space-y-4 rounded-2xl border bg-card p-6 text-center shadow-lg">
              {error ? (
                <>
                  <p className="text-sm text-destructive">Couldn’t read this video ({error}).</p>
                  <Button variant="outline" onClick={() => setError(null)}>Dismiss</Button>
                </>
              ) : (
                <>
                  <p className="text-sm text-muted-foreground">Sampling frames…</p>
                  <Progress value={Math.round(progress * 100)} />
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ───── panel (cards) ───── */}
      <aside className="flex h-[46dvh] w-full shrink-0 flex-col gap-3 overflow-y-auto p-3 *:shrink-0 md:h-full md:w-[24rem] md:pl-0">
        <Card className="gap-4">
          <CardHeader>
            <div className="flex items-start justify-between gap-3">
              <div>
                <CardTitle className="text-xl font-semibold tracking-tight">Time Slice</CardTitle>
              </div>
              <Button variant="ghost" size="sm" onClick={() => scene().reset()}>
                <RotateCcw /> Reset
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <Button size="lg" className="w-full" onClick={() => scene().toggleFocus()} title="F or double-click the slice">
              {focused ? <Minimize2 /> : <Maximize2 />}
              {focused ? 'Exit full view' : 'Fill screen with slice'}
            </Button>
          </CardContent>
        </Card>

        <Section title="Slice plane">
          <Field label="Azimuth" htmlFor="az" right={
            <NumField value={slice.az} min={-180} max={180} step={0.1} decimals={1} suffix="°" onCommit={(v) => scene().setSlice({ az: v })} />}>
            <Slider id="az" min={-180} max={180} step={0.5} value={[slice.az]} onValueChange={(v) => scene().setSlice({ az: first(v) })} />
          </Field>
          <Field label="Elevation" htmlFor="el" right={
            <NumField value={slice.el} min={-90} max={90} step={0.1} decimals={1} suffix="°" onCommit={(v) => scene().setSlice({ el: v })} />}>
            <Slider id="el" min={-90} max={90} step={0.5} value={[slice.el]} onValueChange={(v) => scene().setSlice({ el: first(v) })} />
          </Field>
          <Field label="Position" htmlFor="pos" right={
            <NumField value={slice.pos} min={-POS_LIMIT} max={POS_LIMIT} step={0.001} decimals={3} onCommit={(v) => scene().setSlice({ pos: v })} />}>
            <Slider id="pos" min={-POS_LIMIT} max={POS_LIMIT} step={0.001} value={[slice.pos]} onValueChange={(v) => scene().setSlice({ pos: first(v) })} />
          </Field>
        </Section>

        <Section title="Presets">
          <div className="grid grid-cols-2 gap-2.5">
            {PRESETS.map((p) => (
              <Button key={p.label} variant="outline" onClick={() => scene().setSlice({ az: p.az, el: p.el, pos: 0 })}>
                {p.label}{p.hint && <span className="text-muted-foreground">{p.hint}</span>}
              </Button>
            ))}
          </div>
        </Section>

        <Section title="Playback">
          <div className="grid grid-cols-2 gap-2.5">
            <Button variant="secondary" onClick={() => scene().togglePlaying()}>
              {playing ? <Pause /> : <Play />} {playing ? 'Pause' : 'Play'}
            </Button>
            <Select items={MODES} value={mode} onValueChange={(v) => { setMode(v as string); scene().setMode(v as string); }}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {MODES.map((m) => <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <Field label="Speed" right={<span className={valueCls}>{speed.toFixed(2)}×</span>}>
            <Slider min={0.1} max={3} step={0.05} value={[speed]} onValueChange={(v) => { setSpeed(first(v)); scene().setSpeed(first(v)); }} />
          </Field>
        </Section>

        <Section title="Display">
          <Field label="Stack frames" right={<span className={valueCls}>{stackCount}</span>}>
            <Slider min={4} max={120} step={1} value={[stackCount]} onValueChange={(v) => { setStackCount(first(v)); scene().setStackCount(first(v)); }} />
          </Field>
          <Field label="Stack opacity" right={<span className={valueCls}>{stackOpacity.toFixed(2)}</span>}>
            <Slider min={0} max={1} step={0.01} value={[stackOpacity]} onValueChange={(v) => { setStackOpacity(first(v)); scene().setStackOpacity(first(v)); }} />
          </Field>
        </Section>

        <Section title="Source">
          <input ref={fileRef} type="file" accept="video/*" className="hidden" onChange={onFile} />
          <Button variant="outline" className="w-full" onClick={() => fileRef.current?.click()}>
            <Upload /> Load another video
          </Button>
        </Section>
      </aside>
    </div>
  );
}

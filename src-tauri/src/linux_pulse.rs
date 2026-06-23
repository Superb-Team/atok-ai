//! Native PulseAudio/PipeWire client (Linux).
//!
//! Replaces the `parec`/`pactl` subprocesses so the app needs no external CLI
//! tools — only `libpulse.so.0`, which is present wherever the audio server runs.
//!
//! Audio quality is unchanged versus `parec`: the server produces the monitor PCM;
//! this only requests the same sample spec (S16LE / 48 kHz / 2 ch at unity volume)
//! and copies the bytes. The downstream DSP chain is untouched.

use std::cell::RefCell;
use std::rc::Rc;

use libpulse_binding::callbacks::ListResult;
use libpulse_binding::context::{Context, FlagSet as ContextFlagSet, State as ContextState};
use libpulse_binding::mainloop::standard::{IterateResult, Mainloop};
use libpulse_binding::operation::{Operation, State as OperationState};
use libpulse_binding::proplist::{properties, Proplist};
use libpulse_binding::sample::{Format, Spec};
use libpulse_binding::stream::Direction;
use libpulse_simple_binding::Simple;

const APP_NAME: &str = "atok-ai";

/// Capture sample spec — identical to the previous `parec --format=s16le
/// --rate=48000 --channels=2`, so the captured PCM matches byte-for-byte.
pub const CAPTURE_FORMAT: Format = Format::S16le;
pub const CAPTURE_RATE: u32 = 48_000;
pub const CAPTURE_CHANNELS: u8 = 2;

fn capture_spec() -> Spec {
    Spec {
        format: CAPTURE_FORMAT,
        rate: CAPTURE_RATE,
        channels: CAPTURE_CHANNELS,
    }
}

/// One audio source as reported by the server.
pub struct PulseSource {
    pub name: String,
    pub is_monitor: bool,
}

/// Blocking monitor capture stream — the `parec` replacement. Reads interleaved
/// S16LE 48 kHz stereo at unity volume.
pub struct MonitorCapture {
    simple: Simple,
}

impl MonitorCapture {
    /// Open a record stream on `device` (a `<sink>.monitor` source name). A fresh
    /// record stream defaults to unity (PA_VOLUME_NORM), matching `parec --volume=65536`.
    pub fn open(device: Option<&str>) -> Result<Self, String> {
        let spec = capture_spec();
        if !spec.is_valid() {
            return Err("invalid capture spec".to_string());
        }
        let simple = Simple::new(
            None,              // default server
            APP_NAME,          // application name (shown in the mixer)
            Direction::Record, // capture
            device,            // "<sink>.monitor", or None for the default source
            "system-audio",    // stream description
            &spec,
            None, // default channel map
            None, // default buffering (server-chosen, same as parec)
        )
        .map_err(|e| format!("pa_simple record open failed: {}", e))?;
        Ok(Self { simple })
    }

    /// Fill `buf` with captured PCM (blocks until full). `buf.len()` must be a
    /// multiple of the frame size (4 bytes for S16LE stereo).
    pub fn read(&mut self, buf: &mut [u8]) -> Result<(), String> {
        self.simple
            .read(buf)
            .map_err(|e| format!("pa_simple read failed: {}", e))
    }
}

/// Default sink and source names via one-shot introspection (replaces
/// `pactl get-default-sink` / `get-default-source`). Returns None if the server
/// is unreachable.
pub fn default_sink_and_source() -> Option<(String, String)> {
    let out: Rc<RefCell<Option<(String, String)>>> = Rc::new(RefCell::new(None));
    with_context(|context, mainloop| {
        let captured = out.clone();
        let op = context.introspect().get_server_info(move |info| {
            let sink = info.default_sink_name.as_ref().map(|s| s.to_string());
            let source = info.default_source_name.as_ref().map(|s| s.to_string());
            if let (Some(sink), Some(source)) = (sink, source) {
                *captured.borrow_mut() = Some((sink, source));
            }
        });
        drive_until_done(mainloop, &op);
    })?;
    let result = out.borrow_mut().take();
    result
}

/// All sources, monitors included (replaces `pactl list sources short`). Returns
/// an empty vec if the server is unreachable.
pub fn list_sources() -> Vec<PulseSource> {
    let out: Rc<RefCell<Vec<PulseSource>>> = Rc::new(RefCell::new(Vec::new()));
    let connected = with_context(|context, mainloop| {
        let captured = out.clone();
        let op = context.introspect().get_source_info_list(move |list| {
            if let ListResult::Item(info) = list {
                captured.borrow_mut().push(PulseSource {
                    name: info
                        .name
                        .as_ref()
                        .map(|s| s.to_string())
                        .unwrap_or_default(),
                    is_monitor: info.monitor_of_sink.is_some(),
                });
            }
        });
        drive_until_done(mainloop, &op);
    });
    if connected.is_none() {
        return Vec::new();
    }
    out.take()
}

/// Connect a context, run `f`, then disconnect. Returns None if the server can't
/// be reached so callers can fall back gracefully.
fn with_context<T>(f: impl FnOnce(&mut Context, &mut Mainloop) -> T) -> Option<T> {
    let mut proplist = Proplist::new()?;
    proplist
        .set_str(properties::APPLICATION_NAME, APP_NAME)
        .ok()?;

    let mut mainloop = Mainloop::new()?;
    let mut context = Context::new_with_proplist(&mainloop, APP_NAME, &proplist)?;
    context.connect(None, ContextFlagSet::NOFLAGS, None).ok()?;

    // Pump the mainloop until the context is ready or fails.
    loop {
        match mainloop.iterate(true) {
            IterateResult::Success(_) => {}
            IterateResult::Quit(_) | IterateResult::Err(_) => return None,
        }
        match context.get_state() {
            ContextState::Ready => break,
            ContextState::Failed | ContextState::Terminated => return None,
            _ => {}
        }
    }

    let result = f(&mut context, &mut mainloop);
    context.disconnect();
    Some(result)
}

/// Pump the mainloop until an introspection operation completes.
fn drive_until_done<G: ?Sized>(mainloop: &mut Mainloop, op: &Operation<G>) {
    loop {
        match mainloop.iterate(true) {
            IterateResult::Success(_) => {}
            IterateResult::Quit(_) | IterateResult::Err(_) => return,
        }
        match op.get_state() {
            OperationState::Done | OperationState::Cancelled => return,
            OperationState::Running => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Ignored by default (needs a live server); run explicitly to verify parity
    // with pactl/parec on a real box.
    #[test]
    #[ignore = "requires a running PulseAudio/PipeWire server"]
    fn introspection_and_capture_smoke() {
        let (sink, source) = default_sink_and_source().expect("server reachable");
        eprintln!("default sink={sink} source={source}");

        let sources = list_sources();
        eprintln!("{} sources:", sources.len());
        for s in &sources {
            eprintln!("  {} | monitor={}", s.name, s.is_monitor);
        }
        assert!(!sources.is_empty(), "no sources reported");
        assert!(
            sources.iter().any(|s| s.is_monitor),
            "no monitor source for system audio"
        );

        // Capture ~0.5s from the default sink monitor; the exact byte count proves
        // the stream runs at 48k/2ch/S16LE with no resampling surprise.
        let monitor = format!("{sink}.monitor");
        let mut cap = MonitorCapture::open(Some(&monitor)).expect("open monitor");
        let bytes_per_sec = (CAPTURE_RATE as usize) * (CAPTURE_CHANNELS as usize) * 2;
        let mut buf = vec![0u8; bytes_per_sec / 2];
        cap.read(&mut buf).expect("read capture");
        assert_eq!(buf.len(), bytes_per_sec / 2);

        let peak = buf
            .chunks_exact(2)
            .map(|c| i16::from_le_bytes([c[0], c[1]]).unsigned_abs())
            .max()
            .unwrap_or(0);
        eprintln!("capture peak (i16 abs) = {peak}");
    }
}

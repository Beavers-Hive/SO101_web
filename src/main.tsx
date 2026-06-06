import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  Armchair,
  Bot,
  Check,
  ChevronLeft,
  CircleStop,
  Gauge,
  Gamepad2,
  Home,
  Joystick,
  Link,
  Plus,
  RotateCcw,
  Satellite,
  Send,
  Settings,
  SlidersHorizontal,
  Square,
  Unplug,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import { FeetechService, MOTOR_IDS, MOTOR_LIMITS, MOTOR_NAMES, type MotorId, type MotorSnapshot } from "./feetech";
import "./styles.css";

type View = "home" | "teleop" | "motor";
type LinkState = "offline" | "connecting" | "online";
type ArmRole = "leader" | "follower";
type TeleopMode = "manual" | "read" | "follow";
type MotionFrame = {
  time: number;
  positions: Partial<Record<MotorId, number>>;
};

type JointKey = "base" | "shoulder" | "elbow" | "wristPitch" | "wristRoll" | "gripper";

type Arm = {
  id: string;
  name: string;
  role: ArmRole;
  state: LinkState;
  joints: Record<JointKey, number>;
};

const initialJoints: Record<JointKey, number> = {
  base: MOTOR_LIMITS[1].home,
  shoulder: MOTOR_LIMITS[2].home,
  elbow: MOTOR_LIMITS[3].home,
  wristPitch: MOTOR_LIMITS[4].home,
  wristRoll: MOTOR_LIMITS[5].home,
  gripper: MOTOR_LIMITS[6].home,
};

const jointMeta: Array<{ key: JointKey; motorId: MotorId; label: string; min: number; max: number; unit: string }> = [
  { key: "base", motorId: 1, label: "Shoulder pan", ...MOTOR_LIMITS[1], unit: "" },
  { key: "shoulder", motorId: 2, label: "Shoulder lift", ...MOTOR_LIMITS[2], unit: "" },
  { key: "elbow", motorId: 3, label: "Elbow flex", ...MOTOR_LIMITS[3], unit: "" },
  { key: "wristPitch", motorId: 4, label: "Wrist flex", ...MOTOR_LIMITS[4], unit: "" },
  { key: "wristRoll", motorId: 5, label: "Wrist roll", ...MOTOR_LIMITS[5], unit: "" },
  { key: "gripper", motorId: 6, label: "Gripper", ...MOTOR_LIMITS[6], unit: "" },
];

const makeRoom = () => `room-${Math.random().toString(36).slice(2, 9)}`;
const motorIdByJoint = new Map(jointMeta.map((joint) => [joint.key, joint.motorId]));
const jointKeyByMotorId = new Map(jointMeta.map((joint) => [joint.motorId, joint.key]));

// Median of up to three samples. Used to reject single-sample read glitches
// (which otherwise get baked into the recording and make the follower jerk
// toward an extreme during playback) while preserving genuine ramps.
function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function normalizeRecordedFrames(frames: MotionFrame[], targetIds: MotorId[]) {
  const lastKnown = new Map<MotorId, number>();

  return frames.map((frame) => {
    const positions: Partial<Record<MotorId, number>> = {};
    targetIds.forEach((id) => {
      const current = frame.positions[id];
      if (current !== undefined) {
        lastKnown.set(id, current);
        positions[id] = current;
      } else {
        const previous = lastKnown.get(id);
        if (previous !== undefined) positions[id] = previous;
      }
    });
    return { ...frame, positions };
  });
}

function App() {
  const [view, setView] = useState<View>("home");
  const [serialState, setSerialState] = useState<LinkState>("offline");
  const [leaderSerialState, setLeaderSerialState] = useState<LinkState>("offline");
  const [followerSerialState, setFollowerSerialState] = useState<LinkState>("offline");
  const [teleopMode, setTeleopMode] = useState<TeleopMode>("manual");
  const [activeArmId, setActiveArmId] = useState("leader-1");
  const [deadman, setDeadman] = useState(false);
  const [speed, setSpeed] = useState(34);
  const [lastCommand, setLastCommand] = useState("standby");
  const [log, setLog] = useState<string[]>(["console ready"]);
  const [motors, setMotors] = useState<Map<MotorId, MotorSnapshot>>(new Map());
  const [discoveredMotorIds, setDiscoveredMotorIds] = useState<MotorId[]>([]);
  const [leaderMotors, setLeaderMotors] = useState<Map<MotorId, MotorSnapshot>>(new Map());
  const [followerMotors, setFollowerMotors] = useState<Map<MotorId, MotorSnapshot>>(new Map());
  const [leaderMotorIds, setLeaderMotorIds] = useState<MotorId[]>([]);
  const [followerMotorIds, setFollowerMotorIds] = useState<MotorId[]>([]);
  const [isFollowing, setIsFollowing] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isPlayingMotion, setIsPlayingMotion] = useState(false);
  const [recordedFrames, setRecordedFrames] = useState<MotionFrame[]>([]);
  const feetechRef = useRef(new FeetechService());
  const leaderFeetechRef = useRef(new FeetechService());
  const followerFeetechRef = useRef(new FeetechService());
  const monitorRef = useRef<number | null>(null);
  // A single self-paced loop drives both follow and record so the leader is
  // read once per cycle and shared, instead of two loops fighting over the
  // serial port (which made follow stutter while recording).
  const leaderLoopRef = useRef<number | null>(null);
  const recordingStartedAtRef = useRef(0);
  const recordedFramesRef = useRef<MotionFrame[]>([]);
  const lastRecordedPositionsRef = useRef<Map<MotorId, number>>(new Map());
  const rawReadHistoryRef = useRef<Map<MotorId, number[]>>(new Map());
  const recordingActiveRef = useRef(false);
  const isFollowingRef = useRef(false);
  const followSharedIdsRef = useRef<MotorId[]>([]);
  const leaderMotorIdsRef = useRef<MotorId[]>([]);
  const playbackCancelledRef = useRef(false);

  const [arms, setArms] = useState<Arm[]>([
    { id: "leader-1", name: "SO101 Arm", role: "leader", state: "offline", joints: initialJoints },
    {
      id: "follower-1",
      name: "Remote follower",
      role: "follower",
      state: "offline",
      joints: initialJoints,
    },
  ]);

  useEffect(() => {
    leaderMotorIdsRef.current = leaderMotorIds;
  }, [leaderMotorIds]);

  useEffect(() => {
    return () => {
      if (monitorRef.current) {
        window.clearInterval(monitorRef.current);
      }
      recordingActiveRef.current = false;
      isFollowingRef.current = false;
      if (leaderLoopRef.current) {
        window.clearTimeout(leaderLoopRef.current);
      }
      void feetechRef.current.disconnect();
      void leaderFeetechRef.current.disconnect();
      void followerFeetechRef.current.disconnect();
    };
  }, []);

  const browserOk = "serial" in navigator;
  const activeArm = arms.find((arm) => arm.id === activeArmId) ?? arms[0];

  const appendLog = (message: string) => {
    const stamp = new Intl.DateTimeFormat("ja-JP", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date());
    setLog((items) => [`${stamp} ${message}`, ...items].slice(0, 9));
  };

  const setLocalArmPositions = (positions: Map<MotorId, number>) => {
    setArms((items) =>
      items.map((arm) => {
        if (arm.id !== "leader-1") return arm;
        const nextJoints = { ...arm.joints };
        positions.forEach((position, id) => {
          const key = jointKeyByMotorId.get(id);
          if (key) nextJoints[key] = position;
        });
        return { ...arm, state: "online", joints: nextJoints };
      }),
    );
  };

  const refreshMotorSnapshots = async (ids = discoveredMotorIds) => {
    if (ids.length === 0 || !feetechRef.current.connected) return;
    const snapshots = new Map<MotorId, MotorSnapshot>();
    const positions = new Map<MotorId, number>();
    for (const id of ids) {
      try {
        const snapshot = await feetechRef.current.readSnapshot(id);
        snapshots.set(id, snapshot);
        if (snapshot.position !== null) positions.set(id, snapshot.position);
      } catch (error) {
        appendLog(`read ID ${id} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    setMotors(snapshots);
    if (positions.size > 0) setLocalArmPositions(positions);
  };

  const readServiceSnapshots = async (service: FeetechService, ids: MotorId[]) => {
    const snapshots = new Map<MotorId, MotorSnapshot>();
    for (const id of ids) {
      try {
        snapshots.set(id, await service.readSnapshot(id));
      } catch (error) {
        appendLog(`read ID ${id} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return snapshots;
  };

  const startMonitoring = (ids: MotorId[]) => {
    if (monitorRef.current) window.clearInterval(monitorRef.current);
    monitorRef.current = window.setInterval(() => {
      void refreshMotorSnapshots(ids);
    }, 1000);
  };

  const sendCommand = async (payload: string, action: () => Promise<void>) => {
    setLastCommand(payload);
    appendLog(payload);
    try {
      await action();
    } catch (error) {
      appendLog(error instanceof Error ? error.message : String(error));
    }
  };

  const connectSerial = async () => {
    if (!navigator.serial) {
      appendLog("Web Serial is not available");
      return;
    }
    setSerialState("connecting");
    try {
      await feetechRef.current.connect();
      setSerialState("online");
      appendLog("SO101 serial connected at 1000000 baud");
      appendLog("scanning motor IDs 1-6");
      const ids = await feetechRef.current.scanMotors();
      setDiscoveredMotorIds(ids);
      await feetechRef.current.setAllTorque(ids, false);
      appendLog(ids.length > 0 ? `found motors: ${ids.join(", ")}` : "no motors found");
      setArms((items) => items.map((arm) => (arm.id === "leader-1" ? { ...arm, state: ids.length > 0 ? "online" : "offline" } : arm)));
      await refreshMotorSnapshots(ids);
      startMonitoring(ids);
    } catch (error) {
      setSerialState("offline");
      appendLog(error instanceof Error ? error.message : "serial connection failed");
    }
  };

  const disconnectSerial = async () => {
    if (monitorRef.current) {
      window.clearInterval(monitorRef.current);
      monitorRef.current = null;
    }
    await feetechRef.current.disconnect();
    setSerialState("offline");
    setMotors(new Map());
    setDiscoveredMotorIds([]);
    setArms((items) => items.map((arm) => (arm.id === "leader-1" ? { ...arm, state: "offline" } : arm)));
    appendLog("serial disconnected");
  };

  const connectTeleopSerial = async (role: "leader" | "follower") => {
    const service = role === "leader" ? leaderFeetechRef.current : followerFeetechRef.current;
    const setState = role === "leader" ? setLeaderSerialState : setFollowerSerialState;
    const setIds = role === "leader" ? setLeaderMotorIds : setFollowerMotorIds;
    const setSnapshots = role === "leader" ? setLeaderMotors : setFollowerMotors;
    const label = role === "leader" ? "leader" : "follower";

    if (!navigator.serial) {
      appendLog("Web Serial is not available");
      return;
    }

    setState("connecting");
    try {
      await service.connect();
      setState("online");
      appendLog(`${label} serial connected`);
      const ids = await service.scanMotors();
      setIds(ids);
      appendLog(`${label} found motors: ${ids.join(", ") || "-"}`);
      await service.setAllTorque(ids, role === "leader" ? false : false);
      setSnapshots(await readServiceSnapshots(service, ids));
    } catch (error) {
      setState("offline");
      appendLog(`${label} connect failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const disconnectTeleopSerial = async (role: "leader" | "follower") => {
    const service = role === "leader" ? leaderFeetechRef.current : followerFeetechRef.current;
    const setState = role === "leader" ? setLeaderSerialState : setFollowerSerialState;
    const setIds = role === "leader" ? setLeaderMotorIds : setFollowerMotorIds;
    const setSnapshots = role === "leader" ? setLeaderMotors : setFollowerMotors;
    await service.disconnect();
    setState("offline");
    setIds([]);
    setSnapshots(new Map());
    appendLog(`${role} serial disconnected`);
  };

  const refreshTeleopPair = async () => {
    if (leaderFeetechRef.current.connected && leaderMotorIds.length > 0) {
      setLeaderMotors(await readServiceSnapshots(leaderFeetechRef.current, leaderMotorIds));
    }
    if (followerFeetechRef.current.connected && followerMotorIds.length > 0) {
      setFollowerMotors(await readServiceSnapshots(followerFeetechRef.current, followerMotorIds));
    }
  };

  const stopFollow = async () => {
    isFollowingRef.current = false;
    followSharedIdsRef.current = [];
    setIsFollowing(false);
    try {
      await followerFeetechRef.current.setAllTorque(followerMotorIds, false);
    } catch (error) {
      appendLog(error instanceof Error ? error.message : String(error));
    }
    appendLog("follow stopped");
  };

  // Target cycle time for the shared leader loop (ms). The loop is self-paced:
  // it waits for each cycle to finish before scheduling the next, so reads
  // never overlap on the serial port.
  const LEADER_LOOP_INTERVAL_MS = 20;

  // Despike a single cycle of leader reads and append one recorded frame.
  const recordLeaderFrame = (rawPositions: Map<MotorId, number>, cycleStart: number) => {
    const frame: MotionFrame = { time: Math.round(cycleStart - recordingStartedAtRef.current), positions: {} };
    let validCount = 0;

    for (const id of leaderMotorIdsRef.current) {
      const raw = rawPositions.get(id);
      const history = rawReadHistoryRef.current.get(id) ?? [];
      if (raw !== undefined) {
        history.push(raw);
        if (history.length > 3) history.shift();
        rawReadHistoryRef.current.set(id, history);
      }

      // Median-of-3 once enough samples exist so a single spike never lands in
      // the timeline; fall back to latest / last-known before that.
      let value: number | undefined;
      if (history.length >= 3) value = median(history);
      else if (history.length > 0) value = history[history.length - 1];
      else value = lastRecordedPositionsRef.current.get(id);

      if (value !== undefined) {
        frame.positions[id] = value;
        lastRecordedPositionsRef.current.set(id, value);
        if (raw !== undefined) validCount += 1;
      }
    }

    if (validCount > 0) {
      recordedFramesRef.current = [...recordedFramesRef.current, frame];
      setRecordedFrames(recordedFramesRef.current);
    }
  };

  // Single loop that reads the leader once per cycle and feeds both the
  // follower (live follow) and the recorder, so they never contend for the bus.
  const ensureLeaderLoop = () => {
    if (leaderLoopRef.current !== null) return;

    const tick = async () => {
      if (!recordingActiveRef.current && !isFollowingRef.current) {
        leaderLoopRef.current = null;
        return;
      }
      const cycleStart = performance.now();
      const readIds = recordingActiveRef.current ? leaderMotorIdsRef.current : followSharedIdsRef.current;
      const rawPositions = new Map<MotorId, number>();

      for (const id of readIds) {
        try {
          const position = await leaderFeetechRef.current.readPosition(id);
          if (Number.isFinite(position) && position >= 0 && position <= 4095) rawPositions.set(id, position);
        } catch {
          // A dropped sample is fine: record falls back, follow keeps last goal.
        }
      }

      if (isFollowingRef.current) {
        const writeMap = new Map<MotorId, number>();
        followSharedIdsRef.current.forEach((id) => {
          const position = rawPositions.get(id);
          if (position !== undefined) writeMap.set(id, position);
        });
        if (writeMap.size > 0) {
          try {
            await followerFeetechRef.current.writePositions(writeMap);
          } catch (error) {
            appendLog(`follow error: ${error instanceof Error ? error.message : String(error)}`);
          }
          const apply = (items: Map<MotorId, MotorSnapshot>) => {
            const next = new Map(items);
            writeMap.forEach((position, id) => {
              const existing = next.get(id);
              next.set(id, { id, name: MOTOR_NAMES[id], position, voltage: existing?.voltage ?? null, firmwareVersion: existing?.firmwareVersion ?? null });
            });
            return next;
          };
          setLeaderMotors(apply);
          setFollowerMotors(apply);
        }
      }

      if (recordingActiveRef.current) {
        recordLeaderFrame(rawPositions, cycleStart);
      }

      if (!recordingActiveRef.current && !isFollowingRef.current) {
        leaderLoopRef.current = null;
        return;
      }
      const wait = Math.max(0, LEADER_LOOP_INTERVAL_MS - (performance.now() - cycleStart));
      leaderLoopRef.current = window.setTimeout(() => void tick(), wait);
    };

    // Mark the loop as running before the first await so concurrent callers
    // (e.g. starting record while already following) don't spawn a second one.
    leaderLoopRef.current = window.setTimeout(() => void tick(), 0);
  };

  const startRecording = () => {
    if (!leaderFeetechRef.current.connected || leaderMotorIds.length === 0) {
      appendLog("leader must be connected before recording");
      return;
    }
    if (recordingActiveRef.current) return;
    recordedFramesRef.current = [];
    lastRecordedPositionsRef.current = new Map();
    rawReadHistoryRef.current = new Map();
    setRecordedFrames([]);
    recordingStartedAtRef.current = performance.now();
    recordingActiveRef.current = true;
    setIsRecording(true);
    appendLog("motion recording started");
    ensureLeaderLoop();
  };

  const stopRecording = () => {
    recordingActiveRef.current = false;
    setIsRecording(false);
    setRecordedFrames(recordedFramesRef.current);
    appendLog(`motion recording stopped: ${recordedFramesRef.current.length} frames`);
  };

  const clearRecording = () => {
    recordingActiveRef.current = false;
    recordedFramesRef.current = [];
    rawReadHistoryRef.current = new Map();
    setRecordedFrames([]);
    setIsRecording(false);
    appendLog("motion recording cleared");
  };

  const exportRecording = () => {
    const frames = recordedFramesRef.current;
    if (frames.length === 0) {
      appendLog("no recorded motion to export");
      return;
    }
    const involvedIds = Array.from(new Set([...leaderMotorIds, ...followerMotorIds])).sort((a, b) => a - b) as MotorId[];
    const motorNames: Partial<Record<MotorId, string>> = {};
    const motorLimits: Partial<Record<MotorId, { min: number; max: number; home: number }>> = {};
    involvedIds.forEach((id) => {
      motorNames[id] = MOTOR_NAMES[id];
      motorLimits[id] = MOTOR_LIMITS[id];
    });

    const payload = {
      version: 1,
      app: "so101-teleoperation-console",
      createdAt: new Date().toISOString(),
      durationMs: frames.length > 0 ? frames[frames.length - 1].time : 0,
      frameCount: frames.length,
      leader: {
        role: "leader",
        motorIds: leaderMotorIds,
        connection: leaderFeetechRef.current.getConnectionInfo(),
      },
      follower: {
        role: "follower",
        motorIds: followerMotorIds,
        connection: followerFeetechRef.current.getConnectionInfo(),
      },
      motorNames,
      motorLimits,
      frames,
    };

    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `so101-motion-${stamp}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
    appendLog(`exported ${frames.length} frames to ${anchor.download}`);
  };

  const stopPlayback = async () => {
    playbackCancelledRef.current = true;
    setIsPlayingMotion(false);
    try {
      await followerFeetechRef.current.setAllTorque(followerMotorIds, false);
    } catch (error) {
      appendLog(error instanceof Error ? error.message : String(error));
    }
    appendLog("motion playback stopped");
  };

  const playRecording = async () => {
    const frames = normalizeRecordedFrames(recordedFramesRef.current, followerMotorIds);
    if (!followerFeetechRef.current.connected || followerMotorIds.length === 0) {
      appendLog("follower must be connected before playback");
      return;
    }
    if (frames.length === 0) {
      appendLog("no recorded motion to play");
      return;
    }

    // Playback must own the follower bus exclusively. If we are still
    // following/recording, the shared leader loop would keep writing the
    // leader's current (rest) position to the follower and fight the playback,
    // dragging it back toward origin. Stop that loop first.
    if (isFollowingRef.current || recordingActiveRef.current) {
      isFollowingRef.current = false;
      recordingActiveRef.current = false;
      followSharedIdsRef.current = [];
      setIsFollowing(false);
      setIsRecording(false);
      if (leaderLoopRef.current !== null) {
        window.clearTimeout(leaderLoopRef.current);
        leaderLoopRef.current = null;
      }
      appendLog("follow/record stopped for playback");
    }

    playbackCancelledRef.current = false;
    setIsPlayingMotion(true);
    appendLog(`motion playback started: ${frames.length} frames`);

    const idsInMotion = new Set<MotorId>();
    frames.forEach((frame) => {
      Object.keys(frame.positions).forEach((id) => {
        const motorId = Number(id) as MotorId;
        if (followerMotorIds.includes(motorId)) idsInMotion.add(motorId);
      });
    });

    try {
      await followerFeetechRef.current.setAllTorque([...idsInMotion], true);
      // Schedule against an absolute wall clock anchored at frame 0 so a slow
      // write never accumulates drift: each frame is played at its recorded
      // offset, and we skip the wait (not the write) if we are already behind.
      const playbackStart = performance.now();
      const firstOffset = frames[0].time;
      for (const frame of frames) {
        if (playbackCancelledRef.current) break;
        const targetTime = playbackStart + (frame.time - firstOffset);
        const wait = targetTime - performance.now();
        if (wait > 0) await new Promise((resolve) => window.setTimeout(resolve, wait));
        const positions = new Map<MotorId, number>();
        Object.entries(frame.positions).forEach(([id, position]) => {
          const motorId = Number(id) as MotorId;
          if (position !== undefined && followerMotorIds.includes(motorId)) positions.set(motorId, position);
        });
        if (positions.size > 0) await followerFeetechRef.current.writePositions(positions);
      }
      appendLog(playbackCancelledRef.current ? "motion playback cancelled" : "motion playback finished");
    } catch (error) {
      appendLog(`playback error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsPlayingMotion(false);
    }
  };

  const startFollow = async () => {
    if (!leaderFeetechRef.current.connected || !followerFeetechRef.current.connected) {
      appendLog("leader and follower must both be connected");
      return;
    }
    const sharedIds = leaderMotorIds.filter((id) => followerMotorIds.includes(id));
    if (sharedIds.length === 0) {
      appendLog("no shared motor IDs between leader and follower");
      return;
    }

    await followerFeetechRef.current.setAllTorque(sharedIds, true);
    followSharedIdsRef.current = sharedIds;
    isFollowingRef.current = true;
    setIsFollowing(true);
    appendLog(`follow started for IDs ${sharedIds.join(", ")}`);
    ensureLeaderLoop();
  };



  const updateJoint = (key: JointKey, value: number) => {
    setArms((items) =>
      items.map((arm) => (arm.id === activeArm.id ? { ...arm, joints: { ...arm.joints, [key]: value } } : arm)),
    );
    const motorId = motorIdByJoint.get(key);
    if (!motorId) return;
    if (!deadman) {
      setLastCommand(`preview ID ${motorId} -> ${value} (Enable off)`);
      return;
    }
    void sendCommand(`write GOAL_POSITION ID ${motorId} -> ${value}`, async () => {
      await feetechRef.current.writePosition(motorId, value);
      setMotors((items) => new Map(items).set(motorId, { id: motorId, name: MOTOR_NAMES[motorId], position: value, voltage: items.get(motorId)?.voltage ?? null, firmwareVersion: items.get(motorId)?.firmwareVersion ?? null }));
    });
  };

  const setTorqueForDiscovered = async (enabled: boolean) => {
    await sendCommand(`torque ${enabled ? "enable" : "disable"} IDs ${discoveredMotorIds.join(", ") || "-"}`, async () => {
      await feetechRef.current.setAllTorque(discoveredMotorIds, enabled);
    });
  };

  const writeHomePose = async () => {
    const positions = new Map<MotorId, number>();
    discoveredMotorIds.forEach((id) => positions.set(id, MOTOR_LIMITS[id].home));
    await sendCommand("sync write home pose", async () => {
      await feetechRef.current.writePositions(positions);
      setLocalArmPositions(positions);
    });
  };

  const writeReadyPose = async () => {
    const positions = new Map<MotorId, number>();
    discoveredMotorIds.forEach((id) => {
      const limit = MOTOR_LIMITS[id];
      positions.set(id, Math.round((limit.min + limit.max) / 2));
    });
    await sendCommand("sync write ready pose", async () => {
      await feetechRef.current.writePositions(positions);
      setLocalArmPositions(positions);
    });
  };

  const sweepMotor = async (id: MotorId) => {
    await sendCommand(`sweep ID ${id}`, async () => {
      const limit = MOTOR_LIMITS[id];
      const center = activeArm.joints[jointKeyByMotorId.get(id) ?? "base"] ?? limit.home;
      await feetechRef.current.writePosition(id, Math.max(limit.min, center - 120));
      await new Promise((resolve) => window.setTimeout(resolve, 350));
      await feetechRef.current.writePosition(id, Math.min(limit.max, center + 120));
      await new Promise((resolve) => window.setTimeout(resolve, 350));
      await feetechRef.current.writePosition(id, center);
    });
  };

  const addArm = (role: ArmRole) => {
    const nextNumber = arms.filter((arm) => arm.role === role).length + 1;
    const id = `${role}-${nextNumber}`;
    const nextArm: Arm = {
      id,
      name: `${role === "leader" ? "Leader" : "Follower"} ${String.fromCharCode(64 + nextNumber)}`,
      role,
      state: role === "leader" ? "online" : "offline",
      joints: { ...initialJoints },
    };
    setArms((items) => [...items, nextArm]);
    setActiveArmId(id);
    appendLog(`${nextArm.name} added`);
  };


  const statusItems = useMemo(
    () => [
      { label: "Serial", state: serialState, icon: Link },
    ],
    [serialState],
  );

  return (
    <div className="app-shell">
      <Header
        view={view}
        browserOk={browserOk}
        statusItems={statusItems}
        onHome={() => setView("home")}
      />
      {view === "home" && (
        <HomeView
          onTeleop={() => setView("teleop")}
          onMotor={() => setView("motor")}
        />
      )}
      {view === "teleop" && (
        <TeleopView
          arms={arms}
          activeArm={activeArm}
          teleopMode={teleopMode}
          deadman={deadman}
          speed={speed}
          log={log}
          lastCommand={lastCommand}
          serialState={serialState}
          leaderSerialState={leaderSerialState}
          followerSerialState={followerSerialState}
          motors={motors}
          discoveredMotorIds={discoveredMotorIds}
          leaderMotors={leaderMotors}
          followerMotors={followerMotors}
          leaderMotorIds={leaderMotorIds}
          followerMotorIds={followerMotorIds}
          isFollowing={isFollowing}
          isRecording={isRecording}
          isPlayingMotion={isPlayingMotion}
          recordedFrames={recordedFrames}
          setActiveArmId={setActiveArmId}
          setTeleopMode={setTeleopMode}
          setDeadman={setDeadman}
          setSpeed={setSpeed}
          addArm={addArm}
          connectSerial={connectSerial}
          disconnectSerial={disconnectSerial}
          updateJoint={updateJoint}
          refreshMotors={() => refreshMotorSnapshots()}
          connectTeleopSerial={connectTeleopSerial}
          disconnectTeleopSerial={disconnectTeleopSerial}
          refreshTeleopPair={refreshTeleopPair}
          startFollow={startFollow}
          stopFollow={stopFollow}
          startRecording={startRecording}
          stopRecording={stopRecording}
          clearRecording={clearRecording}
          exportRecording={exportRecording}
          playRecording={playRecording}
          stopPlayback={stopPlayback}
          writeHomePose={writeHomePose}
          writeReadyPose={writeReadyPose}
          enableTorque={() => setTorqueForDiscovered(true)}
          emergencyStop={() => setTorqueForDiscovered(false)}
        />
      )}
      {view === "motor" && (
        <MotorTestView
          serialState={serialState}
          activeArm={activeArm}
          arms={arms}
          setActiveArmId={setActiveArmId}
          connectSerial={connectSerial}
          disconnectSerial={disconnectSerial}
          motors={motors}
          discoveredMotorIds={discoveredMotorIds}
          refreshMotors={() => refreshMotorSnapshots()}
          setTorque={setTorqueForDiscovered}
          writeHomePose={writeHomePose}
          sweepMotor={sweepMotor}
          onHome={() => setView("home")}
        />
      )}
    </div>
  );
}

function Header({
  view,
  browserOk,
  statusItems,
  onHome,
}: {
  view: View;
  browserOk: boolean;
  statusItems: Array<{ label: string; state: LinkState; icon: React.ElementType }>;
  onHome: () => void;
}) {
  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-mark">
          <Bot size={24} />
        </div>
        <div>
          <h1>{view === "teleop" ? "SO-101 テレオペレーション" : view === "motor" ? "モーターテスト" : "SO-101 Remote Control"}</h1>
          <p>{view === "home" ? "Web Serial API による遠隔ジョイント制御システム" : "遠隔ジョイント制御の操作コンソール"}</p>
        </div>
      </div>
      <div className="header-actions">
        {view !== "home" && (
          <button className="icon-text subtle" onClick={onHome}>
            <Home size={16} />
            ホーム
          </button>
        )}
        <div className="status-strip">
          {statusItems.map((item) => (
            <StatusPill key={item.label} {...item} />
          ))}
        </div>
      </div>
      {!browserOk && <div className="notice">ChromeまたはEdgeデスクトップ版をご利用ください</div>}
    </header>
  );
}

function StatusPill({ label, state, icon: Icon }: { label: string; state: LinkState; icon: React.ElementType }) {
  return (
    <span className={`status-pill ${state}`}>
      <Icon size={13} />
      {label}
      {state === "online" ? <Check size={13} /> : state === "connecting" ? <Activity size={13} /> : <X size={13} />}
    </span>
  );
}

function HomeView({ onTeleop, onMotor }: { onTeleop: () => void; onMotor: () => void }) {
  return (
    <main className="home-grid">
      <section className="launch-panel teleop">
        <div className="panel-icon">
          <Joystick size={28} />
        </div>
        <h2>テレオペレーション</h2>
        <p>Web Serial API経由でロボットアームをPCに直接接続し、リアルタイムで関節制御・追従動作やモーション再生を行えます。</p>
        <button className="primary-action" onClick={onTeleop}>
          <Bot size={18} />
          テレオペレーションを開始
        </button>
      </section>
      <section className="launch-panel motor">
        <div className="panel-icon">
          <Wrench size={28} />
        </div>
        <h2>モーターテスト</h2>
        <p>SO-101ロボットアームの個別モーター動作確認、ゼロ点復帰、スイープ動作、グリッパー確認を行えます。</p>
        <button className="primary-action" onClick={onMotor}>
          <Wrench size={18} />
          モーターテストを開始
        </button>
      </section>
    </main>
  );
}

function TeleopView(props: {
  arms: Arm[];
  activeArm: Arm;
  teleopMode: TeleopMode;
  deadman: boolean;
  speed: number;
  log: string[];
  lastCommand: string;
  serialState: LinkState;
  leaderSerialState: LinkState;
  followerSerialState: LinkState;
  motors: Map<MotorId, MotorSnapshot>;
  discoveredMotorIds: MotorId[];
  leaderMotors: Map<MotorId, MotorSnapshot>;
  followerMotors: Map<MotorId, MotorSnapshot>;
  leaderMotorIds: MotorId[];
  followerMotorIds: MotorId[];
  isFollowing: boolean;
  isRecording: boolean;
  isPlayingMotion: boolean;
  recordedFrames: MotionFrame[];
  setActiveArmId: (id: string) => void;
  setTeleopMode: (mode: TeleopMode) => void;
  setDeadman: (value: boolean) => void;
  setSpeed: (value: number) => void;
  addArm: (role: ArmRole) => void;
  connectSerial: () => void;
  disconnectSerial: () => void;
  updateJoint: (key: JointKey, value: number) => void;
  refreshMotors: () => void;
  connectTeleopSerial: (role: "leader" | "follower") => void;
  disconnectTeleopSerial: (role: "leader" | "follower") => void;
  refreshTeleopPair: () => void;
  startFollow: () => void;
  stopFollow: () => void;
  startRecording: () => void;
  stopRecording: () => void;
  clearRecording: () => void;
  exportRecording: () => void;
  playRecording: () => void;
  stopPlayback: () => void;
  writeHomePose: () => void;
  writeReadyPose: () => void;
  enableTorque: () => void;
  emergencyStop: () => void;
}) {
  return (
    <main className="workspace">
      <div className="teleop-layout" style={{ marginTop: "0" }}>
        <section className="connection-column">
          <div className="panel-header">
            <h2>アーム接続状況</h2>
          </div>
          <TeleopStatusPanel
            serialState={props.serialState}
            leaderSerialState={props.leaderSerialState}
            followerSerialState={props.followerSerialState}
            motors={props.motors}
            discoveredMotorIds={props.discoveredMotorIds}
            leaderMotors={props.leaderMotors}
            followerMotors={props.followerMotors}
            leaderMotorIds={props.leaderMotorIds}
            followerMotorIds={props.followerMotorIds}
            connectSerial={props.connectSerial}
            connectTeleopSerial={props.connectTeleopSerial}
            disconnectTeleopSerial={props.disconnectTeleopSerial}
            refreshMotors={props.refreshMotors}
            refreshTeleopPair={props.refreshTeleopPair}
          />
        </section>

        <section className="control-column">
          <div className="panel-header">
            <h2>操作コンソール</h2>
          </div>
          <TeleopControls
            activeArm={props.activeArm}
            teleopMode={props.teleopMode}
            deadman={props.deadman}
            speed={props.speed}
            motors={props.motors}
            discoveredMotorIds={props.discoveredMotorIds}
            leaderMotorIds={props.leaderMotorIds}
            followerMotorIds={props.followerMotorIds}
            isFollowing={props.isFollowing}
            isRecording={props.isRecording}
            isPlayingMotion={props.isPlayingMotion}
            recordedFrames={props.recordedFrames}
            setTeleopMode={props.setTeleopMode}
            setDeadman={(enabled) => {
              props.setDeadman(enabled);
              void (enabled ? props.enableTorque() : props.emergencyStop());
            }}
            setSpeed={props.setSpeed}
            updateJoint={props.updateJoint}
            refreshMotors={props.refreshMotors}
            startFollow={props.startFollow}
            stopFollow={props.stopFollow}
            startRecording={props.startRecording}
            stopRecording={props.stopRecording}
            clearRecording={props.clearRecording}
            exportRecording={props.exportRecording}
            playRecording={props.playRecording}
            stopPlayback={props.stopPlayback}
            writeHomePose={props.writeHomePose}
            writeReadyPose={props.writeReadyPose}
            emergencyStop={props.emergencyStop}
          />
        </section>
      </div>

      <section className="log-dock">
        <div>
          <h3>送信コマンド</h3>
          <code>{props.lastCommand}</code>
        </div>
        <div>
          <h3>イベントログ</h3>
          <ul>
            {props.log.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      </section>
    </main>
  );
}

function TeleopStatusPanel({
  serialState,
  leaderSerialState,
  followerSerialState,
  motors,
  discoveredMotorIds,
  leaderMotors,
  followerMotors,
  leaderMotorIds,
  followerMotorIds,
  connectSerial,
  connectTeleopSerial,
  disconnectTeleopSerial,
  refreshMotors,
  refreshTeleopPair,
}: {
  serialState: LinkState;
  leaderSerialState: LinkState;
  followerSerialState: LinkState;
  motors: Map<MotorId, MotorSnapshot>;
  discoveredMotorIds: MotorId[];
  leaderMotors: Map<MotorId, MotorSnapshot>;
  followerMotors: Map<MotorId, MotorSnapshot>;
  leaderMotorIds: MotorId[];
  followerMotorIds: MotorId[];
  connectSerial: () => void;
  connectTeleopSerial: (role: "leader" | "follower") => void;
  disconnectTeleopSerial: (role: "leader" | "follower") => void;
  refreshMotors: () => void;
  refreshTeleopPair: () => void;
}) {
  return (
    <div className="panel-body">
      <ConnectionBlock
        title="リーダー"
        detail="手で動かす側。トルクOFFで位置を読みます。"
        state={leaderSerialState}
        motors={leaderMotors}
        motorIds={leaderMotorIds}
        onConnect={() => connectTeleopSerial("leader")}
        onDisconnect={() => disconnectTeleopSerial("leader")}
      />
      <ConnectionBlock
        title="フォロワー"
        detail="追従する側。追従中だけトルクONにします。"
        state={followerSerialState}
        motors={followerMotors}
        motorIds={followerMotorIds}
        onConnect={() => connectTeleopSerial("follower")}
        onDisconnect={() => disconnectTeleopSerial("follower")}
      />
      <button className="chip-action full-width" onClick={refreshTeleopPair}>
        <Activity size={15} />
        リーダー/フォロワー再読込
      </button>
      <details className="legacy-connection">
        <summary>1台手動操作用の接続</summary>
        <div className="connection-summary">
          <div>
            <span>接続</span>
            <strong>{serialState === "online" ? "SO101 接続済み" : "SO101 未接続"}</strong>
          </div>
          <StatusDot state={serialState} />
        </div>
        <div className="node-actions">
          <button className="chip-action" onClick={connectSerial}>
            <Satellite size={15} />
            SO101接続
          </button>
          <button className="chip-action green" onClick={refreshMotors}>
            <Activity size={15} />
            再読込
          </button>
        </div>
        <MotorRows motors={motors} motorIds={discoveredMotorIds} emptyText="1台手動操作用の接続結果がここに表示されます。" />
      </details>
    </div>
  );
}

function ConnectionBlock({
  title,
  detail,
  state,
  motors,
  motorIds,
  onConnect,
  onDisconnect,
}: {
  title: string;
  detail: string;
  state: LinkState;
  motors: Map<MotorId, MotorSnapshot>;
  motorIds: MotorId[];
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  return (
    <section className="teleop-connection-block">
      <div className="connection-summary">
        <div>
          <span>{title}</span>
          <strong>{state === "online" ? "接続済み" : state === "connecting" ? "接続中" : "未接続"}</strong>
        </div>
        <StatusDot state={state} />
      </div>
      <p className="muted-text">{detail}</p>
      <div className="node-actions">
        <button className="chip-action" onClick={onConnect}>
          <Satellite size={15} />
          接続
        </button>
        <button className="chip-action danger-lite" onClick={onDisconnect}>
          <Unplug size={15} />
          切断
        </button>
      </div>
      <MotorRows motors={motors} motorIds={motorIds} emptyText="未検出" />
    </section>
  );
}

function MotorRows({
  motors,
  motorIds,
  emptyText,
}: {
  motors: Map<MotorId, MotorSnapshot>;
  motorIds: MotorId[];
  emptyText: string;
}) {
  return (
    <div className="motor-list compact">
      {motorIds.length === 0 ? (
        <p className="muted-text">{emptyText}</p>
      ) : (
        motorIds.map((id) => {
          const motor = motors.get(id);
          return (
            <div className="motor-row" key={id}>
              <strong>ID {id}</strong>
              <span>{MOTOR_NAMES[id]}</span>
              <code>{motor?.position ?? "---"}</code>
              <small>{motor?.voltage ? `${motor.voltage.toFixed(1)}V` : "---"}</small>
            </div>
          );
        })
      )}
    </div>
  );
}

function TeleopControls({
  activeArm,
  teleopMode,
  deadman,
  speed,
  motors,
  discoveredMotorIds,
  leaderMotorIds,
  followerMotorIds,
  isFollowing,
  isRecording,
  isPlayingMotion,
  recordedFrames,
  setTeleopMode,
  setDeadman,
  setSpeed,
  updateJoint,
  refreshMotors,
  startFollow,
  stopFollow,
  startRecording,
  stopRecording,
  clearRecording,
  exportRecording,
  playRecording,
  stopPlayback,
  writeHomePose,
  writeReadyPose,
  emergencyStop,
}: {
  activeArm: Arm;
  teleopMode: TeleopMode;
  deadman: boolean;
  speed: number;
  motors: Map<MotorId, MotorSnapshot>;
  discoveredMotorIds: MotorId[];
  leaderMotorIds: MotorId[];
  followerMotorIds: MotorId[];
  isFollowing: boolean;
  isRecording: boolean;
  isPlayingMotion: boolean;
  recordedFrames: MotionFrame[];
  setTeleopMode: (mode: TeleopMode) => void;
  setDeadman: (value: boolean) => void;
  setSpeed: (value: number) => void;
  updateJoint: (key: JointKey, value: number) => void;
  refreshMotors: () => void;
  startFollow: () => void;
  stopFollow: () => void;
  startRecording: () => void;
  stopRecording: () => void;
  clearRecording: () => void;
  exportRecording: () => void;
  playRecording: () => void;
  stopPlayback: () => void;
  writeHomePose: () => void;
  writeReadyPose: () => void;
  emergencyStop: () => void;
}) {
  const sharedIds = leaderMotorIds.filter((id) => followerMotorIds.includes(id));
  const motionDuration = recordedFrames.length > 0 ? recordedFrames[recordedFrames.length - 1].time : 0;
  const coverage = sharedIds.map((id) => {
    const count = recordedFrames.reduce((sum, frame) => sum + (frame.positions[id] !== undefined ? 1 : 0), 0);
    return { id, count };
  });

  return (
    <div className="panel-body">
      <div className="command-rail compact" style={{ marginBottom: "18px", marginTop: "0" }}>
        <button className="command-button" onClick={writeHomePose}>
          <Home size={18} />
          Home
        </button>
        <button className="command-button" onClick={writeReadyPose}>
          <Zap size={18} />
          Ready
        </button>
        <button className="command-button danger" onClick={emergencyStop}>
          <Square size={18} />
          Stop
        </button>
      </div>

      <div className="mode-switch">
        <button className={teleopMode === "manual" ? "active" : ""} onClick={() => setTeleopMode("manual")}>
          手動
        </button>
        <button className={teleopMode === "read" ? "active" : ""} onClick={() => setTeleopMode("read")}>
          読取
        </button>
        <button className={teleopMode === "follow" ? "active" : ""} onClick={() => setTeleopMode("follow")}>
          追従
        </button>
      </div>
      <div className="control-summary">
        <div>
          <span>{teleopMode === "manual" ? "操作対象" : teleopMode === "read" ? "読取対象" : "追従設定"}</span>
          <strong>{teleopMode === "follow" ? "2台接続時に使用" : activeArm.name}</strong>
        </div>
        {teleopMode === "manual" && (
          <label className="switch-row">
            <input type="checkbox" checked={deadman} onChange={(event) => setDeadman(event.target.checked)} />
            <span>Enable</span>
          </label>
        )}
      </div>

      {teleopMode === "manual" && (
        <>
          <div className={deadman ? "mode-note live" : "mode-note"}>{deadman ? "トルクON: スライダー変更を送信します" : "Enable OFF: 値の確認のみ"}</div>
          <label className="slider-row speed">
            <span>
              <Gauge size={16} />
              Speed
            </span>
            <input type="range" min="1" max="100" value={speed} onChange={(event) => setSpeed(Number(event.target.value))} />
            <strong>{speed}%</strong>
          </label>
          {jointMeta.map((joint) => (
            <label className="slider-row" key={joint.key}>
              <span>{joint.label}</span>
              <input
                type="range"
                min={joint.min}
                max={joint.max}
                value={activeArm.joints[joint.key]}
                onChange={(event) => updateJoint(joint.key, Number(event.target.value))}
              />
              <strong>
                {activeArm.joints[joint.key]}
                {joint.unit}
              </strong>
            </label>
          ))}
        </>
      )}

      {teleopMode === "read" && (
        <div className="read-panel">
          <button className="chip-action" onClick={refreshMotors}>
            <Activity size={15} />
            現在値を読む
          </button>
          <div className="motor-list compact">
            {discoveredMotorIds.length === 0 ? (
              <p className="muted-text">SO101接続後に現在位置を読めます。</p>
            ) : (
              discoveredMotorIds.map((id) => {
                const motor = motors.get(id);
                return (
                  <div className="motor-row" key={id}>
                    <strong>ID {id}</strong>
                    <span>{MOTOR_NAMES[id]}</span>
                    <code>{motor?.position ?? "---"}</code>
                    <small>{motor?.voltage ? `${motor.voltage.toFixed(1)}V` : "---"}</small>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {teleopMode === "follow" && (
        <div className="follow-panel">
          <Gamepad2 size={34} />
          <h3>追従モード</h3>
          <p>リーダーの現在位置を読み、同じIDのフォロワーへ60ms間隔で同期書き込みします。</p>
          <div className={sharedIds.length > 0 ? "mode-note live" : "mode-note"}>
            共通ID: {sharedIds.length > 0 ? sharedIds.join(", ") : "なし"}
          </div>
          <div className="follow-actions">
            <button className="primary-action" disabled={isFollowing || sharedIds.length === 0} onClick={startFollow}>
              <Zap size={17} />
              追従開始
            </button>
            <button className="test-button danger" onClick={stopFollow}>
              <Square size={17} />
              追従停止 / トルクOFF
            </button>
          </div>
          <section className="motion-recorder">
            <div className="recorder-title">
              <h3>モーション録画</h3>
              <span className={isRecording ? "recording-dot live" : "recording-dot"} />
            </div>
            <div className="recording-stats">
              <span>{recordedFrames.length} frames</span>
              <span>{(motionDuration / 1000).toFixed(1)}s</span>
            </div>
            {coverage.length > 0 && (
              <div className="coverage-grid">
                {coverage.map((item) => (
                  <span key={item.id} className={item.count === recordedFrames.length && recordedFrames.length > 0 ? "complete" : ""}>
                    ID {item.id}: {item.count}/{recordedFrames.length}
                  </span>
                ))}
              </div>
            )}
            <div className="follow-actions">
              <button className="test-button" disabled={isRecording || leaderMotorIds.length === 0} onClick={startRecording}>
                <CircleStop size={17} />
                録画開始
              </button>
              <button className="test-button" disabled={!isRecording} onClick={stopRecording}>
                <Square size={17} />
                録画停止
              </button>
              <button className="test-button" disabled={isPlayingMotion || recordedFrames.length === 0 || followerMotorIds.length === 0} onClick={playRecording}>
                <Activity size={17} />
                再生
              </button>
              <button className="test-button danger" disabled={!isPlayingMotion} onClick={stopPlayback}>
                <Square size={17} />
                再生停止
              </button>
              <button className="test-button" disabled={isRecording || recordedFrames.length === 0} onClick={exportRecording}>
                <Send size={17} />
                書き出し
              </button>
              <button className="chip-action danger-lite" disabled={isRecording || isPlayingMotion || recordedFrames.length === 0} onClick={clearRecording}>
                クリア
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function MotorTestView(props: {
  serialState: LinkState;
  activeArm: Arm;
  arms: Arm[];
  setActiveArmId: (id: string) => void;
  connectSerial: () => void;
  disconnectSerial: () => void;
  motors: Map<MotorId, MotorSnapshot>;
  discoveredMotorIds: MotorId[];
  refreshMotors: () => void;
  setTorque: (enabled: boolean) => void;
  writeHomePose: () => void;
  sweepMotor: (id: MotorId) => void;
  onHome: () => void;
}) {
  return (
    <main className="motor-page">
      <section className="serial-card">
        <div className="card-title-row">
          <div>
            <h2>シリアル接続</h2>
            <p>SO-101ロボットアームとの通信接続を管理します</p>
          </div>
          <span className={`state-badge ${props.serialState}`}>{props.serialState === "online" ? "接続済み" : "未接続"}</span>
        </div>
        <div className="serial-actions">
          <button className="primary-action" onClick={props.connectSerial}>
            <Satellite size={17} />
            SO-101に接続
          </button>
          <button className="icon-text subtle" onClick={props.disconnectSerial}>
            <Unplug size={17} />
            切断
          </button>
          <button className="icon-text subtle" onClick={props.refreshMotors}>
            <Activity size={17} />
            再読込
          </button>
        </div>
      </section>

      <section className="test-grid">
        <div className="test-controls">
          <h2>検出モーター</h2>
          <div className="motor-list">
            {props.discoveredMotorIds.length === 0 ? (
              <p className="muted-text">接続するとID 1-6をスキャンします。</p>
            ) : (
              props.discoveredMotorIds.map((id) => {
                const motor = props.motors.get(id);
                return (
                  <div className="motor-row" key={id}>
                    <strong>ID {id}</strong>
                    <span>{MOTOR_NAMES[id]}</span>
                    <code>{motor?.position ?? "---"}</code>
                    <small>{motor?.voltage ? `${motor.voltage.toFixed(1)}V` : "---"}</small>
                  </div>
                );
              })
            )}
          </div>
        </div>
        <div className="test-controls">
          <h2>テストコマンド</h2>
          <div className="test-buttons">
            <button className="test-button" onClick={() => props.setTorque(true)}>
              <Check size={18} />
              トルクON
            </button>
            <button className="test-button" onClick={props.writeHomePose}>
              <RotateCcw size={18} />
              ゼロ点復帰
            </button>
            {props.discoveredMotorIds.map((id) => (
              <button className="test-button" key={id} onClick={() => props.sweepMotor(id)}>
                <SlidersHorizontal size={18} />
                ID {id} 低速スイープ
              </button>
            ))}
            <button className="test-button danger" onClick={() => props.setTorque(false)}>
              <Square size={18} />
              緊急停止 / トルクOFF
            </button>
          </div>
        </div>
      </section>

      <button className="icon-text subtle back-button" onClick={props.onHome}>
        <ChevronLeft size={16} />
        ホームに戻る
      </button>
    </main>
  );
}

function StatusDot({ state }: { state: LinkState }) {
  return <span className={`status-dot ${state}`} aria-label={state} />;
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

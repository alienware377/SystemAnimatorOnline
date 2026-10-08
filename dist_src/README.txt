XR Animator Multi-Camera 3D
===========================

Adds true 3D body tracking to XR Animator by using 2 or more webcams at once.
XR Animator's own camera stays "camera 1" (face, hands and body). Every extra
camera tracks the body too, and after a one-time calibration the joints are
measured in real 3D, so depth, turning sideways and arms hidden behind your
body are much steadier than with one camera.

Made for XR Animator v0.35.0 (Windows desktop version).


WHAT YOU NEED
-------------
- The Windows desktop version of XR Animator, unzipped somewhere.
- 2 webcams. Plug them into different USB ports if you can (two cameras on
  one hub can run out of USB bandwidth).
- Room for both cameras to see your whole body, head to feet.


INSTALL
-------
1. Close XR Animator.
2. Double-click install.bat. It looks for your XR Animator folder by itself;
   if it can't find it, it asks you to pick the folder.
3. To remove it later, double-click uninstall.bat (it restores the originals).


CAMERA PLACEMENT
----------------
- Camera 1 (XR Animator's camera) goes in front of you, as usual.
- Camera 2 works best 45 to 90 degrees to the side, 1.5 to 3 m from where you
  stand. More angle between the cameras = better depth.
- Both cameras must see your whole body. Don't move the cameras after
  calibrating (if you do, calibrate again, it only takes a minute).


FIRST-TIME SETUP
----------------
1. Start XR Animator and start its camera like normal (that's camera 1).
2. Press Ctrl+Shift+M, or click the small "3D" button bottom-left.
3. Under "Extra cameras", tick your second camera. Wait until it shows fps
   (the tracker takes a few seconds to load).
4. Optional: type your height in cm. It makes distances more exact.
5. Click "Calibrate". After the 5 second countdown, for 30 seconds:
   walk around slowly inside the area both cameras see, turn left and
   right, swing and raise your arms, step forward and back.
6. Wait for "Done". The average error should be under about 5 px.
   If it's high, try again with more light and more movement.
7. "Use multi-camera 3D" is on by default. The status line shows how many
   joints are being measured in 3D.

The calibration is remembered. "Save file" / "Load file" keeps a copy.
Your extra cameras reopen automatically next time.

Rough layout (optional): in the Live view's Layout tab, drag the cameras
to roughly where they are and set their height and field of view. With
"Use this layout as a starting guess" ticked, Calibrate starts from it,
which helps with tricky setups (for example one camera behind you).
"Track with this layout now" skips calibration completely. It works, but
it's less exact than a real calibration.


LIVE VIEW (Ctrl+Shift+L, or "Live view" in the 3D panel)
---------------------------------------------------------
- Cameras: every camera's picture with its skeleton. Green = measured in
  3D, yellow = seen by one camera only. White crosses show where the 3D
  result lands in that camera: if they sit on the joints, the calibration
  is good.
- 3D: the room from any angle (drag to turn, scroll or pinch to zoom),
  with the cameras where calibration put them and the live 3D skeleton.
- Layout: the rough room sketch described above.
- Face: live face values and blendshape matching (next section).


FACE BLENDSHAPES
----------------
XR Animator tracks the iPhone ARKit face values (51 of the 52; the tongue
can't be seen by a webcam). In the Face tab you choose which blendshape
names get sent to VNyan, and what drives each one:

1. Add a set of names: "From my avatar" (everything on the avatar loaded
   in XR Animator), ARKit / Perfect Sync, VRM 0 presets, VRM 1 presets,
   MMD morphs, or type your own name.
2. Each name is matched automatically (for example A, aa, vrc.v_aa and
   "a" all become vowel A, Blink_L and ウィンク become left blink).
   Red names have no match yet: pick a source from the list. You can
   change any match by hand, and use XR Animator's own values as a source.
3. Click the gear on any row to fine-tune it, like in VNyan:
   - Strength: multiplies the result
   - Starts at / Full at: the input range. Raise "Starts at" to ignore
     small twitches; lower "Full at" if a shape never reaches 100%.
   - Curve: below 1 reacts earlier, above 1 reacts later
   - Smoothing: steadier but slower
4. "Send over VMC" decides if these are added to what XR Animator already
   sends (yours win on the same name) or sent on their own.
5. Export / Import saves the whole list to a file.

The bars show each result live, with the raw input as a faint bar behind
it. Open "Live ARKit values" to see all 52 inputs.


SENDING TO VNYAN ON ANOTHER PC
------------------------------
In XR Animator's VMC protocol menu, turn on the VMC sender and set:
- Host: the main PC's IP address
- Port: 39539 (VNyan's default VMC receive port)
- Make sure sending avatar data is switched on too. In v0.35.0 it can be
  off, and then only face data goes out and the body doesn't move in VNyan.

On the main PC: in VNyan, turn on the VMC receiver (port 39539). If nothing
arrives, allow VNyan through Windows Firewall (or allow UDP port 39539).

Over Wi-Fi: use the main PC's normal IP (run "ipconfig" there to see it).

Over a cable (USB to Ethernet adapter on each PC, Ethernet cable between):
give both adapters a fixed address once, in
Settings > Network > Ethernet > IP assignment > Manual (IPv4):
- main PC:  IP 192.168.50.1, subnet mask 255.255.255.0, no gateway
- tablet:   IP 192.168.50.2, subnet mask 255.255.255.0, no gateway
Then use 192.168.50.1 as the VMC host in XR Animator.


GOOD TO KNOW
------------
- Face and hand tracking still come from camera 1 only.
- Blendshape names with Japanese (or other non-English) letters now
  arrive correctly in VNyan. XR Animator's VMC sender used to garble them.
- Avatar position (walking around) still uses XR Animator's own method, but
  it now gets much cleaner data.
- Each extra camera runs its own tracker, so it uses more CPU/GPU. If the
  tablet struggles, lower XR Animator's camera resolution.
- "Keep the avatar level" ignores camera 1's tilt. Turn it off to get the
  old behaviour.
- If camera 1 is swapped for a different camera, the panel warns you;
  calibrate again.

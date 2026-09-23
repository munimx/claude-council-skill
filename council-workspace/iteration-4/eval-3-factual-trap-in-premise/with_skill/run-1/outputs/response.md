**Council verdict: Partly.** Keep multiprocessing.Pool and tune it for memory first. Switch to threads only after a benchmark on your real library proves it, because Python 3.13 did not remove the GIL.
Confidence: **low**. The imaging library, interpreter build and memory breakdown in production are all unknown, and each one decides between tuning the pool and switching to threads. The analysts split two ways (two for tuning, one each for the two thread options), and no fact-check covered thread throughput with a real imaging library.

**What you asked:** Whether there is anything technically wrong with replacing multiprocessing.Pool-based image-resizing workers with a ThreadPoolExecutor in Python 3.13, on the premise that GIL removal makes threading suitable for… → **what you're after:** Decide, before implementing it, whether this refactor is a sound way to reduce memory usage without degrading correctness or performance of the image-resizing workload.

### Answer
Tune the pool now and measure in parallel. Move to threads only if the measurement supports it.

1. Find out what you are running. On the production interpreter, run:
`python -c "import sys,sysconfig;print(sysconfig.get_config_var('Py_GIL_DISABLED'), sys._is_gil_enabled())"`
Also record the imaging library and its version. Do not switch to python3.13t for this change.

2. Measure memory properly. Record per-worker PSS (from /proc/<pid>/smaps_rollup or smem), not RSS, especially if the pool uses fork. Split it into:
- idle per-worker overhead (about 45–55 MB per worker in the analysts' tests)
- decoded buffers per image in flight (a 3000x3000 RGB image is about 27 MB decoded; the analysts measured about 48 MB with resize copies; 4000x3000 is about 36 MB)

3. Apply the cheap cuts, which work under any executor:
- Decode JPEGs at reduced scale with Image.draft('RGB', target) or reduce(). This is likely the biggest single saving.
- Set workers to no more than the core count.
- Set maxtasksperchild to about 100–500.
- Use chunksize=1, and pass file paths rather than image bytes.
- Keep MAX_IMAGE_PIXELS set.
- Cap images in flight with a semaphore or bounded queue.
- On glibc, try MALLOC_ARENA_MAX=2.

4. Run an A/B test on production images: ThreadPoolExecutor(N) against Pool(N), measuring wall time and peak PSS.
- If threads reach near-pool throughput (at least about 4x serial on 8 cores) and per-worker overhead is a large share of memory, switch to threads. Prefer a few processes each running a thread pool if you want crash isolation and worker recycling.
- If threads scale poorly, the library is holding the GIL. Stay on the tuned pool.

The switch only helps when the heavy work runs in C that releases the GIL. Pillow does this. For Pillow 11.3 on standard 3.13.3, two analysts measured:
- 8 threads: 10.6 s at 434 MB, against a spawned Pool(8) at 10.5 s and about 830 MB.
- In a second test, 8 threads ran at 6.5 img/s using 360 MiB, against 5.3 img/s and about 780 MiB for the pool.

If you do switch, remove or lock any module-level mutable state in the resize path, and never share one Image object between threads.

### Why
- The stated reason for switching to threads is false. Standard Python 3.13 keeps the GIL. The free-threaded build is separate and experimental, and it silently turns the GIL back on when an unsupported C extension is imported. A CPU-bound pure-Python loop got slower, not faster, with more threads on standard 3.13.3.
- Threads do remove per-worker interpreter and library duplication (4 processes peaked at about 2.2 GB against about 0.43 GB for 4 threads in a direct test). But that only turns into a throughput-safe saving if the imaging library releases the GIL, and the library here is unknown.
- Decoded image buffers grow with the number of images in flight under either executor. Reduced-scale decoding and an in-flight cap are therefore the levers that work no matter which executor wins.
- Tuning the pool is reversible in minutes and carries no thread-safety risk. It does not stop you moving to threads later once the benchmark holds.

### Options weighed
1. ✅ Keep multiprocessing.Pool and tune it for lower memory (worker count, maxtasksperchild, start method, shared memory for image buffers): **recommended**
2. ❌ Keep multiprocessing.Pool unchanged: unsound. Doing nothing does not serve the stated goal of cutting memory. Cheap, low-risk savings are available (reduced-scale decoding, worker count at or below core count, a cap on images in flight).
3. ◐ Use a hybrid: a small number of processes, each running a thread pool: partly sound. This is the right next step if measurement shows per-process overhead dominates and the library releases the GIL. It keeps crash isolation and worker recycling that a single thread pool loses.
4. ◐ Replace multiprocessing.Pool with ThreadPoolExecutor: partly sound. The stated reason is false: 3.13 did not remove the GIL. The move can still work on the standard build if the library does its heavy work in C with the GIL released.

### Your premises, checked
| Claim | Verdict | Basis |
|---|---|---|
| The GIL is removed in Python 3.13. | ❌ does not hold | Accurate version: Python 3.13 did not remove the GIL. It introduced experimental, opt-in support for a free-threaded build (via PEP 703) that can run with the GIL disabled, but this build is not the default — the standard 3.13 interpreter still ships with the… |
| In Python 3.13, threads run CPU-bound Python work in parallel across cores, so threading is suitable for CPU-bound work. | ❌ does not hold | Accurate version: In standard/default Python 3.13 (the normal `python3.13` build), the GIL remains enabled, so threads do NOT run CPU-bound Python bytecode in parallel across cores — they still take turns holding the GIL, and threading is not suitable for… |
| Replacing multiprocessing.Pool with ThreadPoolExecutor materially reduces memory usage for this image-resizing workload. | ◐ partly | the analysts' assessment, not tool-verified |
| The image-resizing work is CPU-bound in a way that depends on the GIL being absent to parallelise across threads. | ❌ does not hold | the analysts' assessment, not tool-verified |

### Do these first
- **do first** (verified): Do not adopt python3.13t for this change. It is experimental, slower for single-threaded code, and any unsupported C extension silently turns the GIL back on. If it is ever used, confirm sys._is_gil_enabled() returns False at runtime.
- **do first** (verified): Measure per-worker PSS and split it into idle overhead versus in-flight buffers before choosing between tuning and threads. The size of the thread saving depends on this split.
- **do first** (verified): Before any thread-based design, run a thread-versus-pool benchmark on the production interpreter, imaging library and real images. If threads do not reach near-pool throughput, the library holds the GIL and threads will cut throughput.
- **do alongside**: Cap images in flight explicitly with a semaphore or bounded queue, and use reduced-scale JPEG decoding. Buffer memory scales with concurrency under either executor, and ThreadPoolExecutor's queue has no size limit.
- **do alongside**: If you move to threads, you lose maxtasksperchild leak containment and crash isolation. Keep some process recycling, for example a few processes each running a thread pool, and remove any module-level mutable state from the resize path.
- **minor** (verified): One fact-check found the interpreter and Pillow version on the machine used for this analysis (3.13.3, Pillow 11.3.0). That says nothing about your production service. Those facts still need checking there.

### Corrections to the premises
- Python 3.13 did not remove the GIL. It added an experimental, opt-in free-threaded build (python3.13t) that is not the default. Even that build turns the GIL back on when it imports a C extension not marked as supporting free threading.
- On the standard 3.13 build, threads do not run CPU-bound Python code in parallel. In a test on 3.13.3, 2 and 4 threads running the same loop took 1.31x and 1.60x longer in total than one thread. Only C code that releases the GIL, such as Pillow's decode, resize and encode, runs in parallel across threads.
- Partly true. Threads avoid duplicating interpreter and library memory in each worker: in one test, 4 processes peaked at about 2.2 GB against about 0.43 GB for 4 threads. Decoded image buffers are not saved, because they scale with the number of images in flight either way. The real saving depends on how memory splits between the two.
- The per-worker saving is the interpreter plus imported libraries, measured at about 30 MB per spawned worker in a small test and about 45–55 MB in the analysts' Pillow tests. It is not the image buffers.
- Resizing with a library like Pillow does not depend on the GIL being absent. Pillow already releases the GIL inside its C resample loops, so threads can run it in parallel on the standard build. Pure-Python processing steps would not run in parallel.

### Where you and the council disagree
You said: "since the GIL is gone in Python 3.13, threading is now fine for CPU-bound work, so I'm going to replace our multiprocessing.Pool image-resizing workers with a ThreadPoolExecutor to cut memory usage"
The council recommends: Keep multiprocessing.Pool and tune it for lower memory (worker count, maxtasksperchild, start method, shared memory for image buffers).
What the council may be missing: Nobody measured glibc malloc arena growth under many threads, or fork-with-threads hazards if the start method stays fork. Python 3.14 changed the default start method on Linux to forkserver, which affects copy-on-write sharing. The resize path may also include steps outside Pillow, such as colour management, EXIF handling or custom filters, that hold the GIL. Container memory limits and OOM behaviour under rare very large images were not considered.
Cost if the council is wrong: If threads would have worked, you keep roughly 45–55 MB per worker of avoidable memory for longer, and you spend effort tuning a pool you later replace. Tuning is quick to reverse, so the cost is mainly delay, not damage.
Your call stays the default until you decide otherwise.

### Minority report
**option 4: Replace multiprocessing.Pool with ThreadPoolExecutor** (Claude Fable): I still recommend replacing multiprocessing.Pool with a ThreadPoolExecutor, on the standard Python 3.13 build, gated by one measurement.

The premise most analysts are reacting to is wrong, and that is why they retreat to "tune the pool": 3.13 did not remove the GIL. But the refactor does not need a free-threaded interpreter. Pillow releases the GIL inside its C decode, resize and encode loops, so threads run the real work in parallel on the normal interpreter. I measured this, not guessed it: standard 3.13.3, Pillow 11.3, 8 cores, 48 large JPEGs resized with LANCZOS. Serial took 64 s; eight threads took 10.6 s at 434 MB peak; a spawned Pool of eight took 10.5 s at roughly 830 MB. Identical throughput, about 45% less memory, because each process carries ~45 MB of interpreter and library that threads share once.

What the majority underweights: tuning the pool cannot remove that per-worker baseline. maxtasksperchild fixes leaks, not duplication; fewer workers cuts memory only by cutting throughput; shared memory for buffers adds complexity for the part of memory that threads do not save anyway. The code change itself is a few lines with the same map interface and is trivially reversible. The hybrid buys the same threading dependency plus process overhead.

Threads bring no per-worker memory cap, so bound in-flight images explicitly and use JPEG draft mode to shrink decoded buffers, whichever executor you keep.

I would concede if the same A/B on the production interpreter, imaging library and images shows threads failing to reach near-pool throughput, or PSS showing the per-worker baseline is already a small share of total memory.
Not adopted because: The imaging library in production is unknown. The throughput evidence covers Pillow only and comes from the analysts' own scratch runs, not an independent check. A library that holds the GIL would make threads cut throughput several-fold. Most analysts favoured tuning the pool first, and that course is safe under every unknown and does not rule out switching later.
It would be right if: The same thread-vs-pool A/B run on the production interpreter, imaging library and representative images shows threads failing to reach near-pool throughput (library holds the GIL or has thread-unsafe state), or PSS measurement shows the per-worker baseline is already a small fraction of total memory (e.g. fork with copy-on-write sharing), so the switch buys little memory while giving up maxtasksperchild isolation.

### Where this could be wrong
- If production uses Pillow on the standard build and per-worker overhead dominates memory, tuning the pool first delays a roughly 45–50% memory cut that threads would deliver at the same throughput.
- The independent memory test (about 2.2 GB for 4 processes against about 0.43 GB for 4 threads, each touching 200 MB) is larger than overhead alone would explain. The allocations were probably not all live at once, so it may overstate how much threads save on buffer-heavy work.
- Moving image buffers into multiprocessing.shared_memory may add complexity without saving anything, because the buffers still have to exist somewhere.
- **What would change the verdict:** A thread-vs-pool benchmark on the production interpreter, library and images showing thread throughput within about 10% of the pool.; A PSS breakdown showing idle per-worker overhead is most of total memory.; Confirmation that the production imaging library releases the GIL across decode, resize and encode, and that the resize path has no thread-unsafe global state.

_Council: 4 blind seats (Fable, Opus, Sonnet, Opus) · blind vote 1–1–1 · 5 claim(s) settled with tools. All voting seats were Claude models, so their agreement is one model family's view._
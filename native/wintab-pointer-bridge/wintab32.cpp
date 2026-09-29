#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <commctrl.h>

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <cwchar>
#include <deque>
#include <iterator>
#include <limits>
#include <memory>
#include <mutex>
#include <unordered_map>
#include <vector>

#include "wintab_compat.h"

namespace {

constexpr UINT kSpecVersion = 0x0104;
constexpr UINT kImplementationVersion = 0x0100;
constexpr UINT kNominalPacketRate = 120;
constexpr UINT kDefaultQueueSize = 128;
constexpr UINT kMaxHistoryEntries = 256;
constexpr UINT_PTR kSubclassId = static_cast<UINT_PTR>(0x575450454E425249ull);
constexpr WTPKT kPhysicalPacketData =
    PK_X | PK_Y | PK_BUTTONS | PK_NORMAL_PRESSURE | PK_ORIENTATION | PK_ROTATION | PK_CURSOR;
constexpr WTPKT kBridgePacketData =
    PK_CONTEXT | PK_STATUS | PK_TIME | PK_CHANGED | PK_SERIAL_NUMBER | kPhysicalPacketData;

HMODULE g_module = nullptr;
std::mutex g_globalMutex;

struct ScreenBounds {
    LONG left;
    LONG top;
    LONG width;
    LONG height;
};

struct RawSample {
    LONG x;
    LONG y;
    DWORD time;
    DWORD buttons;
    UINT pressure;
    UINT cursor;
    UINT status;
    ORIENTATION orientation;
    ROTATION rotation;
    UINT pointerId;
    bool inRange;
    bool inContact;
};

struct PacketRecord {
    HCTX context;
    UINT status;
    DWORD time;
    WTPKT changed;
    UINT serial;
    UINT cursor;
    DWORD buttons;
    LONG x;
    LONG y;
    LONG z;
    UINT normalPressure;
    int tangentPressure;
    ORIENTATION orientation;
    ROTATION rotation;
};

struct ContextState {
    HCTX handle = nullptr;
    HWND window = nullptr;
    DWORD ownerThread = 0;
    LOGCONTEXTA logContext{};
    bool enabled = false;
    bool onTop = true;
    bool inProximity = false;
    bool hasPrevious = false;
    bool hasSeenPen = false;
    UINT pointerId = 0;
    UINT nextSerial = 1;
    size_t queueLimit = kDefaultQueueSize;
    RawSample previous{};
    std::deque<PacketRecord> packets;
    std::mutex mutex;
    std::vector<HWND> hookedWindows; // guarded by g_globalMutex
};

using ContextPtr = std::shared_ptr<ContextState>;
using WeakContextPtr = std::weak_ptr<ContextState>;

struct WindowBinding {
    std::vector<WeakContextPtr> contexts;
};

std::unordered_map<HCTX, ContextPtr> g_contexts;
std::unordered_map<HWND, std::shared_ptr<WindowBinding>> g_windowBindings;

LRESULT CALLBACK BridgeSubclassProc(
    HWND hwnd,
    UINT message,
    WPARAM wParam,
    LPARAM lParam,
    UINT_PTR subclassId,
    DWORD_PTR referenceData);

ScreenBounds GetScreenBounds() {
    ScreenBounds bounds{};
    bounds.left = GetSystemMetrics(SM_XVIRTUALSCREEN);
    bounds.top = GetSystemMetrics(SM_YVIRTUALSCREEN);
    bounds.width = GetSystemMetrics(SM_CXVIRTUALSCREEN);
    bounds.height = GetSystemMetrics(SM_CYVIRTUALSCREEN);
    if (bounds.width <= 0) {
        bounds.left = 0;
        bounds.width = GetSystemMetrics(SM_CXSCREEN);
    }
    if (bounds.height <= 0) {
        bounds.top = 0;
        bounds.height = GetSystemMetrics(SM_CYSCREEN);
    }
    if (bounds.width <= 0) bounds.width = 1;
    if (bounds.height <= 0) bounds.height = 1;
    return bounds;
}

UINT PacketMessage(const ContextState& context, UINT defaultMessage) {
    const UINT base = context.logContext.lcMsgBase != 0
        ? context.logContext.lcMsgBase
        : WT_DEFBASE;
    return base + (defaultMessage - WT_DEFBASE);
}

UINT UnhookMessage() {
    static const UINT message =
        RegisterWindowMessageW(L"Arena.WinTabPointerBridge.Unhook.1.0");
    return message;
}

ContextPtr FindContext(HCTX handle) {
    std::lock_guard<std::mutex> lock(g_globalMutex);
    const auto found = g_contexts.find(handle);
    return found == g_contexts.end() ? ContextPtr{} : found->second;
}

std::vector<ContextPtr> GetContextsForWindow(HWND hwnd) {
    std::vector<ContextPtr> result;
    std::lock_guard<std::mutex> lock(g_globalMutex);
    const auto found = g_windowBindings.find(hwnd);
    if (found == g_windowBindings.end()) return result;

    auto& entries = found->second->contexts;
    for (auto it = entries.begin(); it != entries.end();) {
        if (auto context = it->lock()) {
            result.push_back(std::move(context));
            ++it;
        } else {
            it = entries.erase(it);
        }
    }
    return result;
}

bool AddWindowHook(const ContextPtr& context, HWND hwnd) {
    if (!context || !IsWindow(hwnd)) return false;

    DWORD processId = 0;
    const DWORD threadId = GetWindowThreadProcessId(hwnd, &processId);
    if (processId != GetCurrentProcessId() || threadId != context->ownerThread) {
        return false;
    }

    std::lock_guard<std::mutex> lock(g_globalMutex);
    auto found = g_windowBindings.find(hwnd);
    std::shared_ptr<WindowBinding> binding;
    if (found == g_windowBindings.end()) {
        binding = std::make_shared<WindowBinding>();
        if (!SetWindowSubclass(hwnd, BridgeSubclassProc, kSubclassId, 0)) {
            return false;
        }
        g_windowBindings.emplace(hwnd, binding);
    } else {
        binding = found->second;
    }

    const bool alreadyBound = std::any_of(
        binding->contexts.begin(), binding->contexts.end(),
        [&context](const WeakContextPtr& weak) {
            const auto locked = weak.lock();
            return locked && locked.get() == context.get();
        });
    if (!alreadyBound) {
        binding->contexts.emplace_back(context);
        context->hookedWindows.push_back(hwnd);
    }
    return true;
}

BOOL CALLBACK EnumChildHookProc(HWND child, LPARAM parameter) {
    auto* context = reinterpret_cast<ContextPtr*>(parameter);
    if (context && *context) AddWindowHook(*context, child);
    return TRUE;
}

void HookDescendants(const ContextPtr& context) {
    if (!context || !IsWindow(context->window)) return;
    ContextPtr contextCopy = context;
    EnumChildWindows(
        context->window,
        EnumChildHookProc,
        reinterpret_cast<LPARAM>(&contextCopy));
}

void RemoveContextHooks(const ContextPtr& context) {
    if (!context) return;
    std::vector<HWND> removeSubclass;
    {
        std::lock_guard<std::mutex> lock(g_globalMutex);
        for (const HWND hwnd : context->hookedWindows) {
            const auto found = g_windowBindings.find(hwnd);
            if (found == g_windowBindings.end()) continue;

            auto& entries = found->second->contexts;
            entries.erase(
                std::remove_if(entries.begin(), entries.end(),
                    [&context](const WeakContextPtr& weak) {
                        const auto locked = weak.lock();
                        return !locked || locked.get() == context.get();
                    }),
                entries.end());
            if (entries.empty()) {
                g_windowBindings.erase(found);
                removeSubclass.push_back(hwnd);
            }
        }
        context->hookedWindows.clear();
    }

    const UINT unhookMessage = UnhookMessage();
    for (const HWND hwnd : removeSubclass) {
        if (!IsWindow(hwnd)) continue;
        DWORD processId = 0;
        const DWORD threadId = GetWindowThreadProcessId(hwnd, &processId);
        if (threadId == GetCurrentThreadId()) {
            RemoveWindowSubclass(hwnd, BridgeSubclassProc, kSubclassId);
        } else if (unhookMessage != 0) {
            PostMessageW(hwnd, unhookMessage, 0, 0);
        }
    }
}

void ForgetDestroyedWindow(HWND hwnd) {
    std::lock_guard<std::mutex> lock(g_globalMutex);
    const auto found = g_windowBindings.find(hwnd);
    if (found == g_windowBindings.end()) return;

    for (const auto& weak : found->second->contexts) {
        if (auto context = weak.lock()) {
            auto& windows = context->hookedWindows;
            windows.erase(std::remove(windows.begin(), windows.end(), hwnd), windows.end());
        }
    }
    g_windowBindings.erase(found);
}

bool ShouldSuppressPenMouseCompatibility() {
    static const bool enabled = []() {
        if (g_module == nullptr) return true;
        WCHAR path[MAX_PATH]{};
        const DWORD length = GetModuleFileNameW(g_module, path, MAX_PATH);
        if (length == 0 || length >= MAX_PATH) return true;
        WCHAR* separator = std::wcsrchr(path, L'\\');
        if (!separator) return true;
        const size_t remaining = MAX_PATH - static_cast<size_t>(separator - path) - 1;
        static constexpr WCHAR iniName[] = L"wintab-pointer-bridge.ini";
        if (_countof(iniName) > remaining) return true;
        std::memcpy(separator + 1, iniName, sizeof(iniName));
        return GetPrivateProfileIntW(
            L"Bridge", L"SuppressPenMouse", 1, path) != 0;
    }();
    return enabled;
}

bool IsMouseMessage(UINT message) {
    switch (message) {
        case WM_MOUSEMOVE:
        case WM_LBUTTONDOWN:
        case WM_LBUTTONUP:
        case WM_LBUTTONDBLCLK:
        case WM_RBUTTONDOWN:
        case WM_RBUTTONUP:
        case WM_RBUTTONDBLCLK:
        case WM_MBUTTONDOWN:
        case WM_MBUTTONUP:
        case WM_MBUTTONDBLCLK:
        case WM_XBUTTONDOWN:
        case WM_XBUTTONUP:
        case WM_XBUTTONDBLCLK:
            return true;
        default:
            return false;
    }
}

bool IsPenPromotedMouseMessage() {
    constexpr ULONG_PTR kPenOrTouchSignature = 0xFF515700u;
    constexpr ULONG_PTR kSignatureMask = 0xFFFFFF00u;
    constexpr ULONG_PTR kTouchFlag = 0x00000080u;
    const ULONG_PTR extra = static_cast<ULONG_PTR>(GetMessageExtraInfo());
    return (extra & kSignatureMask) == kPenOrTouchSignature && (extra & kTouchFlag) == 0;
}

bool IsContextReceiving(const ContextPtr& context, bool requireSeenPen) {
    std::lock_guard<std::mutex> lock(context->mutex);
    return context->enabled && context->onTop && (!requireSeenPen || context->hasSeenPen);
}

LONG MapRange(LONG value, LONG sourceOrigin, LONG sourceExtent,
              LONG destinationOrigin, LONG destinationExtent) {
    if (sourceExtent == 0 || destinationExtent == 0) return destinationOrigin;
    const std::int64_t delta = static_cast<std::int64_t>(value) - sourceOrigin;
    const std::int64_t mapped = static_cast<std::int64_t>(destinationOrigin) +
        (delta * static_cast<std::int64_t>(destinationExtent)) / sourceExtent;
    return static_cast<LONG>(std::clamp<std::int64_t>(
        mapped, std::numeric_limits<LONG>::min(), std::numeric_limits<LONG>::max()));
}

LONG MapScreenX(const ContextState& context, LONG x) {
    const ScreenBounds desktop = GetScreenBounds();
    const LONG sourceOrigin = context.logContext.lcSysMode && context.logContext.lcSysExtX != 0
        ? context.logContext.lcSysOrgX
        : desktop.left;
    const LONG sourceExtent = context.logContext.lcSysMode && context.logContext.lcSysExtX != 0
        ? context.logContext.lcSysExtX
        : desktop.width;
    return MapRange(x, sourceOrigin, sourceExtent,
                    context.logContext.lcOutOrgX, context.logContext.lcOutExtX);
}

LONG MapScreenY(const ContextState& context, LONG y) {
    const ScreenBounds desktop = GetScreenBounds();
    const LONG sourceOrigin = context.logContext.lcSysMode && context.logContext.lcSysExtY != 0
        ? context.logContext.lcSysOrgY
        : desktop.top;
    const LONG sourceExtent = context.logContext.lcSysMode && context.logContext.lcSysExtY != 0
        ? context.logContext.lcSysExtY
        : desktop.height;
    return MapRange(y, sourceOrigin, sourceExtent,
                    context.logContext.lcOutOrgY, context.logContext.lcOutExtY);
}

void PostProximity(const ContextPtr& context, bool entering) {
    if (!context) return;
    HWND window = nullptr;
    UINT messageId = 0;
    {
        std::lock_guard<std::mutex> lock(context->mutex);
        if (!context->enabled) return;
        window = context->window;
        messageId = PacketMessage(*context, WT_PROXIMITY);
    }
    if (!IsWindow(window)) return;
    const LPARAM proximity = MAKELPARAM(entering ? 1 : 0, 1);
    PostMessageW(
        window,
        messageId,
        reinterpret_cast<WPARAM>(context->handle),
        proximity);
}

void PostCursorChange(const ContextPtr& context, UINT serial) {
    if (!context) return;
    HWND window = nullptr;
    UINT messageId = 0;
    {
        std::lock_guard<std::mutex> lock(context->mutex);
        if (!context->enabled || (context->logContext.lcOptions & CXO_CSRMESSAGES) == 0) return;
        window = context->window;
        messageId = PacketMessage(*context, WT_CSRCHANGE);
    }
    if (IsWindow(window)) {
        PostMessageW(window, messageId, static_cast<WPARAM>(serial),
                     reinterpret_cast<LPARAM>(context->handle));
    }
}

WTPKT DifferenceMask(const ContextState& context, const RawSample& sample) {
    const WTPKT requested = context.logContext.lcPktData;
    if (!context.hasPrevious) return requested & (kPhysicalPacketData | PK_STATUS | PK_TIME);

    WTPKT changed = 0;
    if (sample.cursor != context.previous.cursor) changed |= PK_CURSOR;
    if (sample.buttons != context.previous.buttons) changed |= PK_BUTTONS;
    if (sample.x != context.previous.x) changed |= PK_X;
    if (sample.y != context.previous.y) changed |= PK_Y;
    if (sample.pressure != context.previous.pressure) changed |= PK_NORMAL_PRESSURE;
    if (std::memcmp(&sample.orientation, &context.previous.orientation, sizeof(ORIENTATION)) != 0) {
        changed |= PK_ORIENTATION;
    }
    if (std::memcmp(&sample.rotation, &context.previous.rotation, sizeof(ROTATION)) != 0) {
        changed |= PK_ROTATION;
    }
    if (sample.status != context.previous.status) changed |= PK_STATUS;
    if (sample.time != context.previous.time) changed |= PK_TIME;
    return changed & requested;
}

UINT NextSerial(ContextState& context) {
    UINT serial = context.nextSerial++;
    if (serial == 0) {
        serial = context.nextSerial++;
    }
    if (context.nextSerial == 0) context.nextSerial = 1;
    return serial;
}

PacketRecord MakePacket(const ContextPtr& context, const RawSample& sample,
                        WTPKT changed, bool relativeButtonPacket,
                        UINT relativeButton, UINT relativeAction) {
    PacketRecord packet{};
    packet.context = context->handle;
    packet.status = sample.status;
    packet.time = sample.time;
    packet.changed = changed;
    packet.serial = NextSerial(*context);
    packet.cursor = sample.cursor;
    packet.buttons = sample.buttons;
    packet.x = MapScreenX(*context, sample.x);
    packet.y = MapScreenY(*context, sample.y);
    packet.z = 0;
    packet.normalPressure = sample.pressure;
    packet.tangentPressure = 0;
    packet.orientation = sample.orientation;
    packet.rotation = sample.rotation;

    const WTPKT mode = context->logContext.lcPktMode;
    if (context->hasPrevious) {
        if (mode & PK_TIME) {
            packet.time = sample.time - context->previous.time;
        }
        if (mode & PK_X) {
            packet.x -= MapScreenX(*context, context->previous.x);
        }
        if (mode & PK_Y) {
            packet.y -= MapScreenY(*context, context->previous.y);
        }
        if (mode & PK_NORMAL_PRESSURE) {
            packet.normalPressure = sample.pressure - context->previous.pressure;
        }
        if (mode & PK_TANGENT_PRESSURE) {
            packet.tangentPressure = 0;
        }
        if (mode & PK_ORIENTATION) {
            packet.orientation.orAzimuth -= context->previous.orientation.orAzimuth;
            packet.orientation.orAltitude -= context->previous.orientation.orAltitude;
            packet.orientation.orTwist -= context->previous.orientation.orTwist;
        }
        if (mode & PK_ROTATION) {
            packet.rotation.roPitch -= context->previous.rotation.roPitch;
            packet.rotation.roRoll -= context->previous.rotation.roRoll;
            packet.rotation.roYaw -= context->previous.rotation.roYaw;
        }
    }

    if (mode & PK_BUTTONS) {
        if (relativeButtonPacket) {
            packet.buttons = ((relativeAction & 0xFFFFu) << 16) | (relativeButton & 0xFFFFu);
        } else {
            packet.buttons = TBN_NONE;
        }
    }
    return packet;
}

bool QueuePacket(const ContextPtr& context, PacketRecord packet) {
    std::lock_guard<std::mutex> lock(context->mutex);
    if (!context->enabled || !context->onTop) return false;
    if (context->packets.size() >= context->queueLimit) {
        context->packets.pop_front();
        packet.status |= TPS_QUEUE_ERR;
    }
    context->packets.push_back(packet);
    return true;
}

void PostPacketNotification(const ContextPtr& context, UINT serial) {
    if (!context) return;
    HWND window = nullptr;
    UINT messageId = 0;
    {
        std::lock_guard<std::mutex> lock(context->mutex);
        if (!context->enabled || !context->onTop ||
            (context->logContext.lcOptions & CXO_MESSAGES) == 0) return;
        window = context->window;
        messageId = PacketMessage(*context, WT_PACKET);
    }
    if (IsWindow(window)) {
        PostMessageW(window, messageId, static_cast<WPARAM>(serial),
                     reinterpret_cast<LPARAM>(context->handle));
    }
}

void ProcessPenInfo(const ContextPtr& context, const POINTER_PEN_INFO& penInfo) {
    if (!context) return;

    const POINTER_INFO& pointer = penInfo.pointerInfo;
    RawSample sample{};
    sample.x = pointer.ptPixelLocation.x;
    sample.y = pointer.ptPixelLocation.y;
    sample.time = pointer.dwTime != 0 ? pointer.dwTime : GetTickCount();
    sample.pointerId = pointer.pointerId;
    sample.inRange = (pointer.pointerFlags & POINTER_FLAG_INRANGE) != 0;
    sample.inContact = (pointer.pointerFlags & POINTER_FLAG_INCONTACT) != 0;
    sample.cursor = (penInfo.penFlags & PEN_FLAG_ERASER) != 0 ? 1u : 0u;
    sample.status = (sample.inRange ? TPS_PROXIMITY : 0u) |
        (sample.cursor != 0 ? TPS_INVERT : 0u);

    if (sample.inContact) sample.buttons |= 0x00000001u; // stylus tip
    if ((penInfo.penFlags & PEN_FLAG_BARREL) != 0) sample.buttons |= 0x00000002u;

    if ((penInfo.penMask & PEN_MASK_PRESSURE) != 0) {
        sample.pressure = std::min<UINT>(penInfo.pressure, 1024u);
    } else {
        // Keep a non-pressure pen usable as a binary-pressure device.
        sample.pressure = sample.inContact ? 1024u : 0u;
    }

    double tiltX = 0.0;
    double tiltY = 0.0;
    if ((penInfo.penMask & PEN_MASK_TILT_X) != 0) tiltX = penInfo.tiltX;
    if ((penInfo.penMask & PEN_MASK_TILT_Y) != 0) tiltY = penInfo.tiltY;
    const double lean = std::min(90.0, std::hypot(tiltX, tiltY));
    double azimuth = std::atan2(tiltX, -tiltY) * (180.0 / 3.14159265358979323846);
    if (azimuth < 0.0) azimuth += 360.0;
    sample.orientation.orAzimuth = static_cast<int>(std::lround(azimuth));
    sample.orientation.orAltitude = static_cast<int>(std::lround(90.0 - lean));

    const int rotation = (penInfo.penMask & PEN_MASK_ROTATION) != 0
        ? static_cast<int>(penInfo.rotation % 360u)
        : 0;
    sample.orientation.orTwist = rotation;
    sample.rotation.roPitch = static_cast<int>(std::lround(tiltY));
    sample.rotation.roRoll = static_cast<int>(std::lround(tiltX));
    sample.rotation.roYaw = rotation;

    bool entering = false;
    bool leaving = false;
    bool cursorChanged = false;
    bool shouldProcess = false;
    std::vector<PacketRecord> packetsToQueue;
    {
        std::lock_guard<std::mutex> lock(context->mutex);
        if (!context->enabled || !context->onTop) return;
        if (context->pointerId != 0 && context->pointerId != sample.pointerId) return;
        if (sample.pointerId == 0) return;

        if (context->pointerId == 0) context->pointerId = sample.pointerId;
        entering = sample.inRange && !context->inProximity;
        leaving = !sample.inRange && context->inProximity;
        cursorChanged = !context->hasPrevious || sample.cursor != context->previous.cursor;
        shouldProcess = sample.inRange || context->inProximity || context->hasPrevious;
        if (!shouldProcess) return;

        if (entering) context->inProximity = true;
        context->hasSeenPen = sample.inRange || context->hasSeenPen;

        const WTPKT changed = DifferenceMask(*context, sample);
        const DWORD changedButtons = context->hasPrevious
            ? (sample.buttons ^ context->previous.buttons)
            : sample.buttons;

        const bool relativeButtons = (context->logContext.lcPktMode & PK_BUTTONS) != 0;
        if (relativeButtons && changedButtons != 0 &&
            (context->logContext.lcPktData & PK_BUTTONS) != 0) {
            for (UINT button = 0; button < 32; ++button) {
                const DWORD bit = (1u << button);
                if ((changedButtons & bit) == 0) continue;
                const bool pressed = (sample.buttons & bit) != 0;
                const UINT action = pressed ? TBN_DOWN : TBN_UP;
                PacketRecord packet = MakePacket(
                    context, sample, changed | PK_BUTTONS, true, button, action);
                packetsToQueue.push_back(packet);
            }
        }

        // Also emit a position/pressure packet when there was no button edge.
        // This deliberately honors packet messages rather than synthesizing mouse input.
        if (packetsToQueue.empty()) {
            PacketRecord packet = MakePacket(context, sample, changed, false, 0, TBN_NONE);
            packetsToQueue.push_back(packet);
        }

        context->previous = sample;
        context->hasPrevious = true;
        if (leaving) {
            context->inProximity = false;
            context->pointerId = 0;
            context->hasPrevious = false;
            context->hasSeenPen = false;
        }
    }

    if (entering) PostProximity(context, true);
    std::vector<UINT> queuedSerials;
    queuedSerials.reserve(packetsToQueue.size());
    for (const PacketRecord& packet : packetsToQueue) {
        if (QueuePacket(context, packet)) queuedSerials.push_back(packet.serial);
    }
    if (cursorChanged && !queuedSerials.empty()) {
        PostCursorChange(context, queuedSerials.front());
    }
    for (const UINT serial : queuedSerials) PostPacketNotification(context, serial);
    if (leaving) PostProximity(context, false);
}

bool IsPenPointerMessage(UINT message) {
    return message == WM_POINTERDOWN || message == WM_POINTERUPDATE ||
        message == WM_POINTERUP || message == WM_POINTERENTER ||
        message == WM_POINTERLEAVE;
}

void HandlePointerMessage(const ContextPtr& context, WPARAM wParam) {
    const UINT pointerId = GET_POINTERID_WPARAM(wParam);
    POINTER_PEN_INFO latest{};
    if (!GetPointerPenInfo(pointerId, &latest)) return;

    UINT available = latest.pointerInfo.historyCount;
    if (available <= 1) {
        ProcessPenInfo(context, latest);
        return;
    }

    const UINT capacity = std::min<UINT>(available, kMaxHistoryEntries);
    std::vector<POINTER_PEN_INFO> history(capacity);
    UINT entries = capacity;
    if (!GetPointerPenInfoHistory(pointerId, &entries, history.data())) {
        ProcessPenInfo(context, latest);
        return;
    }

    const UINT count = std::min<UINT>(capacity, entries);
    if (count == 0) {
        ProcessPenInfo(context, latest);
        return;
    }
    // Windows returns newest-first; WinTab packets must be queued chronologically.
    for (UINT i = count; i > 0; --i) {
        ProcessPenInfo(context, history[i - 1]);
    }
}

LRESULT CALLBACK BridgeSubclassProc(
    HWND hwnd,
    UINT message,
    WPARAM wParam,
    LPARAM lParam,
    UINT_PTR subclassId,
    DWORD_PTR /*referenceData*/) {
    if (message == UnhookMessage()) {
        RemoveWindowSubclass(hwnd, BridgeSubclassProc, subclassId);
        return 0;
    }

    if (message == WM_NCDESTROY) {
        RemoveWindowSubclass(hwnd, BridgeSubclassProc, subclassId);
        const LRESULT result = DefSubclassProc(hwnd, message, wParam, lParam);
        ForgetDestroyedWindow(hwnd);
        return result;
    }

    std::vector<ContextPtr> contexts;
    try {
        contexts = GetContextsForWindow(hwnd);
    } catch (...) {
        return DefSubclassProc(hwnd, message, wParam, lParam);
    }

    if (IsPenPointerMessage(message)) {
        POINTER_INPUT_TYPE pointerType = PT_POINTER;
        const UINT pointerId = GET_POINTERID_WPARAM(wParam);
        if (GetPointerType(pointerId, &pointerType) && pointerType == PT_PEN) {
            for (const ContextPtr& context : contexts) {
                try {
                    HandlePointerMessage(context, wParam);
                } catch (...) {
                    // Input callbacks must never unwind through Photoshop's window procedure.
                }
            }
        }
    }

    if (message == WM_PARENTNOTIFY) {
        const LRESULT result = DefSubclassProc(hwnd, message, wParam, lParam);
        if (LOWORD(wParam) == WM_CREATE) {
            for (const ContextPtr& context : contexts) {
                try {
                    HookDescendants(context);
                } catch (...) {
                    // Keep the original window procedure functional if a child cannot be hooked.
                }
            }
        }
        return result;
    }

    if (IsMouseMessage(message) && IsPenPromotedMouseMessage() &&
        ShouldSuppressPenMouseCompatibility()) {
        const bool bridgeHasPen = std::any_of(
            contexts.begin(), contexts.end(),
            [](const ContextPtr& context) { return IsContextReceiving(context, true); });
        if (bridgeHasPen) return 0;
    }

    return DefSubclassProc(hwnd, message, wParam, lParam);
}

void SetDefaultContextName(LOGCONTEXTA& context, const char* name) {
    std::memset(context.lcName, 0, sizeof(context.lcName));
    const size_t count = std::min(std::strlen(name), sizeof(context.lcName) - 1);
    std::memcpy(context.lcName, name, count);
}

LOGCONTEXTA MakeDefaultContext(bool systemContext) {
    const ScreenBounds desktop = GetScreenBounds();
    LOGCONTEXTA context{};
    SetDefaultContextName(
        context,
        systemContext ? "WM_POINTER System Context" : "WM_POINTER Digitizing Context");
    context.lcOptions = CXO_MESSAGES | CXO_CSRMESSAGES |
        (systemContext ? CXO_SYSTEM : 0u);
    context.lcMsgBase = WT_DEFBASE;
    context.lcDevice = 0;
    context.lcPktRate = kNominalPacketRate;
    context.lcPktData = kBridgePacketData;
    context.lcPktMode = 0;
    context.lcMoveMask = PK_X | PK_Y | PK_TIME | PK_NORMAL_PRESSURE | PK_ORIENTATION;
    context.lcBtnDnMask = 0xFFFFFFFFu;
    context.lcBtnUpMask = 0xFFFFFFFFu;
    context.lcInOrgX = desktop.left;
    context.lcInOrgY = desktop.top;
    context.lcInOrgZ = 0;
    context.lcInExtX = desktop.width;
    context.lcInExtY = desktop.height;
    context.lcInExtZ = 1;
    context.lcOutOrgX = desktop.left;
    context.lcOutOrgY = desktop.top;
    context.lcOutOrgZ = 0;
    context.lcOutExtX = desktop.width;
    context.lcOutExtY = desktop.height;
    context.lcOutExtZ = 1;
    context.lcSensX = 0x00010000u;
    context.lcSensY = 0x00010000u;
    context.lcSensZ = 0x00010000u;
    context.lcSysMode = systemContext ? TRUE : FALSE;
    context.lcSysOrgX = desktop.left;
    context.lcSysOrgY = desktop.top;
    context.lcSysExtX = desktop.width;
    context.lcSysExtY = desktop.height;
    context.lcSysSensX = 0x00010000u;
    context.lcSysSensY = 0x00010000u;
    return context;
}

template <typename T>
UINT CopyValue(LPVOID output, const T& value) {
    if (output != nullptr) std::memcpy(output, &value, sizeof(T));
    return static_cast<UINT>(sizeof(T));
}

template <typename CharT>
UINT CopyString(LPVOID output, const CharT* value, size_t characters) {
    const size_t bytes = characters * sizeof(CharT);
    if (output != nullptr) std::memcpy(output, value, bytes);
    return static_cast<UINT>(bytes);
}

LOGCONTEXTA FromWide(const LOGCONTEXTW& source) {
    LOGCONTEXTA target{};
    for (size_t i = 0; i < LCNAMELEN && source.lcName[i] != L'\0'; ++i) {
        target.lcName[i] = source.lcName[i] <= 0x7F
            ? static_cast<char>(source.lcName[i])
            : '?';
    }
    constexpr size_t sourceOffset = offsetof(LOGCONTEXTW, lcOptions);
    constexpr size_t targetOffset = offsetof(LOGCONTEXTA, lcOptions);
    std::memcpy(
        reinterpret_cast<BYTE*>(&target) + targetOffset,
        reinterpret_cast<const BYTE*>(&source) + sourceOffset,
        sizeof(LOGCONTEXTA) - targetOffset);
    return target;
}

LOGCONTEXTW ToWide(const LOGCONTEXTA& source) {
    LOGCONTEXTW target{};
    for (size_t i = 0; i < LCNAMELEN && source.lcName[i] != '\0'; ++i) {
        target.lcName[i] = static_cast<unsigned char>(source.lcName[i]);
    }
    constexpr size_t sourceOffset = offsetof(LOGCONTEXTA, lcOptions);
    constexpr size_t targetOffset = offsetof(LOGCONTEXTW, lcOptions);
    std::memcpy(
        reinterpret_cast<BYTE*>(&target) + targetOffset,
        reinterpret_cast<const BYTE*>(&source) + sourceOffset,
        sizeof(LOGCONTEXTA) - sourceOffset);
    return target;
}

UINT GetContextInfo(bool wide, UINT category, UINT index, LPVOID output) {
    const LOGCONTEXTA digitizing = MakeDefaultContext(false);
    const LOGCONTEXTA system = MakeDefaultContext(true);

    if (category == 0 && index == 0) {
        // WTInfo(0, 0, NULL) is the customary WinTab availability probe.
        return static_cast<UINT>(wide ? sizeof(LOGCONTEXTW) : sizeof(LOGCONTEXTA));
    }

    if (category == WTI_INTERFACE) {
        if (index == IFC_WINTABID) {
            if (wide) {
                static constexpr WCHAR id[] = L"WM_POINTER WinTab Bridge 0.1";
                return CopyString(output, id, _countof(id));
            }
            static constexpr char id[] = "WM_POINTER WinTab Bridge 0.1";
            return CopyString(output, id, _countof(id));
        }
        if (index == IFC_SPECVERSION) {
            const WORD version = static_cast<WORD>(kSpecVersion);
            return CopyValue(output, version);
        }
        if (index == IFC_IMPLVERSION) {
            const WORD version = static_cast<WORD>(kImplementationVersion);
            return CopyValue(output, version);
        }
        if (index == IFC_NDEVICES) {
            const UINT value = 1;
            return CopyValue(output, value);
        }
        if (index == IFC_NCURSORS) {
            const UINT value = 2;
            return CopyValue(output, value);
        }
        if (index == IFC_NCONTEXTS) {
            const UINT value = 32;
            return CopyValue(output, value);
        }
        if (index == IFC_CTXOPTIONS) {
            const UINT value = CXO_SYSTEM | CXO_MESSAGES | CXO_CSRMESSAGES;
            return CopyValue(output, value);
        }
        if (index == IFC_CTXSAVESIZE || index == IFC_NEXTENSIONS || index == IFC_NMANAGERS) {
            const UINT value = 0;
            return CopyValue(output, value);
        }
        return 0;
    }

    if (category == WTI_STATUS) {
        UINT value = 0;
        switch (index) {
            case STA_CONTEXTS: {
                std::lock_guard<std::mutex> lock(g_globalMutex);
                value = static_cast<UINT>(g_contexts.size());
                break;
            }
            case STA_SYSCTXS: {
                std::lock_guard<std::mutex> lock(g_globalMutex);
                value = static_cast<UINT>(std::count_if(
                    g_contexts.begin(), g_contexts.end(),
                    [](const auto& entry) {
                        std::lock_guard<std::mutex> contextLock(entry.second->mutex);
                        return (entry.second->logContext.lcOptions & CXO_SYSTEM) != 0;
                    }));
                break;
            }
            case STA_PKTRATE:
                value = kNominalPacketRate;
                break;
            case STA_PKTDATA:
                value = kPhysicalPacketData;
                break;
            case STA_MANAGERS:
            case STA_SYSTEM:
            case STA_BUTTONUSE:
            case STA_SYSBTNUSE:
                value = 0;
                break;
            default:
                return 0;
        }
        return CopyValue(output, value);
    }

    if (category == WTI_DEFCONTEXT || category == WTI_DEFSYSCTX) {
        if (index != 0) return 0;
        const LOGCONTEXTA& source = category == WTI_DEFSYSCTX ? system : digitizing;
        if (wide) {
            const LOGCONTEXTW value = ToWide(source);
            return CopyValue(output, value);
        }
        return CopyValue(output, source);
    }

    if (category >= WTI_DEVICES && category < WTI_DEVICES + 10) {
        if (category != WTI_DEVICES) return 0;
        const ScreenBounds desktop = GetScreenBounds();
        switch (index) {
            case DVC_NAME:
                if (wide) {
                    static constexpr WCHAR value[] = L"Windows Pointer Pen (WinTab Bridge)";
                    return CopyString(output, value, _countof(value));
                } else {
                    static constexpr char value[] = "Windows Pointer Pen (WinTab Bridge)";
                    return CopyString(output, value, _countof(value));
                }
            case DVC_HARDWARE: {
                const UINT value = HWC_INTEGRATED | HWC_HARDPROX;
                return CopyValue(output, value);
            }
            case DVC_NCSRTYPE: {
                const UINT value = 2;
                return CopyValue(output, value);
            }
            case DVC_FIRSTCSR: {
                const UINT value = 0;
                return CopyValue(output, value);
            }
            case DVC_PKTRATE: {
                const UINT value = kNominalPacketRate;
                return CopyValue(output, value);
            }
            case DVC_PKTDATA:
                return CopyValue(output, kPhysicalPacketData);
            case DVC_PKTMODE: {
                const UINT value = 0;
                return CopyValue(output, value);
            }
            case DVC_CSRDATA:
                return CopyValue(output, kPhysicalPacketData);
            case DVC_XMARGIN:
            case DVC_YMARGIN:
            case DVC_ZMARGIN: {
                const LONG value = 0;
                return CopyValue(output, value);
            }
            case DVC_X: {
                const AXIS value{desktop.left, desktop.left + desktop.width - 1, TU_NONE, 0};
                return CopyValue(output, value);
            }
            case DVC_Y: {
                const AXIS value{desktop.top, desktop.top + desktop.height - 1, TU_NONE, 0};
                return CopyValue(output, value);
            }
            case DVC_NPRESSURE: {
                const AXIS value{0, 1024, TU_NONE, 0};
                return CopyValue(output, value);
            }
            case DVC_ORIENTATION: {
                constexpr FIX32 fullCircleResolution = static_cast<FIX32>(360u << 16);
                const AXIS values[3] = {
                    {0, 360, TU_CIRCLE, fullCircleResolution},
                    {-90, 90, TU_CIRCLE, fullCircleResolution},
                    {0, 360, TU_CIRCLE, fullCircleResolution},
                };
                return CopyValue(output, values);
            }
            case DVC_ROTATION: {
                constexpr FIX32 fullCircleResolution = static_cast<FIX32>(360u << 16);
                const AXIS values[3] = {
                    {-180, 180, TU_CIRCLE, fullCircleResolution},
                    {-180, 180, TU_CIRCLE, fullCircleResolution},
                    {0, 360, TU_CIRCLE, fullCircleResolution},
                };
                return CopyValue(output, values);
            }
            case DVC_PNPID:
                if (wide) {
                    static constexpr WCHAR value[] = L"PT_PEN";
                    return CopyString(output, value, _countof(value));
                } else {
                    static constexpr char value[] = "PT_PEN";
                    return CopyString(output, value, _countof(value));
                }
            case DVC_Z:
            case DVC_TPRESSURE:
            default:
                return 0;
        }
    }

    if (category >= WTI_CURSORS && category < WTI_CURSORS + 100) {
        const UINT cursor = category - WTI_CURSORS;
        if (cursor > 1) return 0;
        switch (index) {
            case CSR_NAME:
                if (wide) {
                    static constexpr WCHAR stylus[] = L"Pen";
                    static constexpr WCHAR eraser[] = L"Eraser";
                    return cursor == 0
                        ? CopyString(output, stylus, _countof(stylus))
                        : CopyString(output, eraser, _countof(eraser));
                } else {
                    static constexpr char stylus[] = "Pen";
                    static constexpr char eraser[] = "Eraser";
                    return cursor == 0
                        ? CopyString(output, stylus, _countof(stylus))
                        : CopyString(output, eraser, _countof(eraser));
                }
            case CSR_ACTIVE: {
                const UINT value = 1;
                return CopyValue(output, value);
            }
            case CSR_PKTDATA:
                return CopyValue(output, kPhysicalPacketData);
            case CSR_BUTTONS: {
                const UINT value = 2;
                return CopyValue(output, value);
            }
            case CSR_BUTTONBITS: {
                const UINT value = 2;
                return CopyValue(output, value);
            }
            case CSR_CAPABILITIES: {
                const UINT value = CRC_INVERT;
                return CopyValue(output, value);
            }
            case CSR_TYPE:
            case CSR_MODE: {
                const UINT value = cursor;
                return CopyValue(output, value);
            }
            case CSR_MINPKTDATA:
                return CopyValue(output, kPhysicalPacketData);
            case CSR_NPBUTTON:
            case CSR_NPBTNMARKS:
            case CSR_NPRESPONSE:
            case CSR_TPBUTTON:
            case CSR_TPBTNMARKS:
            case CSR_TPRESPONSE:
                return 0;
            default:
                return 0;
        }
    }

    return 0;
}

size_t PacketStride(WTPKT mask) {
    size_t size = 0;
    if (mask & PK_CONTEXT) size += sizeof(HCTX);
    if (mask & PK_STATUS) size += sizeof(UINT);
    if (mask & PK_TIME) size += sizeof(DWORD);
    if (mask & PK_CHANGED) size += sizeof(WTPKT);
    if (mask & PK_SERIAL_NUMBER) size += sizeof(UINT);
    if (mask & PK_CURSOR) size += sizeof(UINT);
    if (mask & PK_BUTTONS) size += sizeof(DWORD);
    if (mask & PK_X) size += sizeof(LONG);
    if (mask & PK_Y) size += sizeof(LONG);
    if (mask & PK_Z) size += sizeof(LONG);
    if (mask & PK_NORMAL_PRESSURE) size += sizeof(UINT);
    if (mask & PK_TANGENT_PRESSURE) size += sizeof(int);
    if (mask & PK_ORIENTATION) size += sizeof(ORIENTATION);
    if (mask & PK_ROTATION) size += sizeof(ROTATION);

    const size_t alignment = (mask & PK_CONTEXT) != 0 ? alignof(HCTX) : alignof(DWORD);
    return (size + alignment - 1) & ~(alignment - 1);
}

void CopyPacketToBuffer(const ContextState& context, const PacketRecord& packet, LPVOID output) {
    if (output == nullptr) return;
    BYTE* destination = static_cast<BYTE*>(output);
    const WTPKT mask = context.logContext.lcPktData;
#define WRITE_FIELD(bit, value) \
    do { \
        if ((mask & (bit)) != 0) { \
            const auto fieldValue = (value); \
            std::memcpy(destination, &fieldValue, sizeof(fieldValue)); \
            destination += sizeof(fieldValue); \
        } \
    } while (0)
    WRITE_FIELD(PK_CONTEXT, packet.context);
    WRITE_FIELD(PK_STATUS, packet.status);
    WRITE_FIELD(PK_TIME, packet.time);
    WRITE_FIELD(PK_CHANGED, packet.changed);
    WRITE_FIELD(PK_SERIAL_NUMBER, packet.serial);
    WRITE_FIELD(PK_CURSOR, packet.cursor);
    WRITE_FIELD(PK_BUTTONS, packet.buttons);
    WRITE_FIELD(PK_X, packet.x);
    WRITE_FIELD(PK_Y, packet.y);
    WRITE_FIELD(PK_Z, packet.z);
    WRITE_FIELD(PK_NORMAL_PRESSURE, packet.normalPressure);
    WRITE_FIELD(PK_TANGENT_PRESSURE, packet.tangentPressure);
    WRITE_FIELD(PK_ORIENTATION, packet.orientation);
    WRITE_FIELD(PK_ROTATION, packet.rotation);
#undef WRITE_FIELD
}

void FlushQueue(ContextState& context) {
    context.packets.clear();
}

int CopyQueuedPackets(const ContextPtr& context, int maximum, LPVOID output,
                      bool remove, bool serialFilter = false,
                      UINT begin = 0, UINT end = 0, LPINT actualCount = nullptr) {
    if (!context || maximum < 0) return 0;
    std::lock_guard<std::mutex> lock(context->mutex);
    if (actualCount != nullptr) *actualCount = 0;
    if (maximum == 0) return 0;

    std::vector<size_t> indices;
    indices.reserve(context->packets.size());
    for (size_t i = 0; i < context->packets.size(); ++i) {
        const UINT serial = context->packets[i].serial;
        if (!serialFilter || static_cast<UINT>(serial - begin) <= static_cast<UINT>(end - begin)) {
            indices.push_back(i);
        }
    }

    const int total = static_cast<int>(indices.size());
    const int copied = std::min<int>(maximum, total);
    if (output != nullptr) {
        BYTE* destination = static_cast<BYTE*>(output);
        for (int i = 0; i < copied; ++i) {
            CopyPacketToBuffer(*context, context->packets[indices[static_cast<size_t>(i)]], destination);
            destination += PacketStride(context->logContext.lcPktData);
        }
    }

    if (actualCount != nullptr) *actualCount = copied;
    if (remove) {
        if (serialFilter) {
            std::vector<UINT> copiedSerials;
            copiedSerials.reserve(static_cast<size_t>(copied));
            for (int i = 0; i < copied; ++i) {
                copiedSerials.push_back(context->packets[indices[static_cast<size_t>(i)]].serial);
            }
            context->packets.erase(
                std::remove_if(context->packets.begin(), context->packets.end(),
                    [&copiedSerials](const PacketRecord& packet) {
                        return std::find(copiedSerials.begin(), copiedSerials.end(), packet.serial) !=
                            copiedSerials.end();
                    }),
                context->packets.end());
        } else {
            for (int i = 0; i < copied && !context->packets.empty(); ++i) {
                context->packets.pop_front();
            }
        }
    }
    return serialFilter ? total : copied;
}

HCTX OpenContext(HWND hwnd, LOGCONTEXTA* input, BOOL enable) {
    if (hwnd == nullptr || input == nullptr || !IsWindow(hwnd)) return nullptr;
    if (input->lcDevice != 0) return nullptr;
    if (input->lcMsgBase == 0) input->lcMsgBase = WT_DEFBASE;
    if (input->lcMsgBase > 0xFFFFu - WT_MAXOFFSET) return nullptr;

    DWORD processId = 0;
    const DWORD ownerThread = GetWindowThreadProcessId(hwnd, &processId);
    if (processId != GetCurrentProcessId() || ownerThread == 0) return nullptr;

    auto context = std::make_shared<ContextState>();
    context->window = hwnd;
    context->ownerThread = ownerThread;
    context->logContext = *input;
    context->logContext.lcStatus = enable ? 0 : CXS_DISABLED;
    context->enabled = enable != FALSE;
    context->onTop = true;
    context->queueLimit = kDefaultQueueSize;
    if (context->logContext.lcName[0] == '\0') {
        SetDefaultContextName(context->logContext, "WM_POINTER Context");
    }

    context->handle = reinterpret_cast<HCTX>(context.get());
    {
        std::lock_guard<std::mutex> lock(g_globalMutex);
        if (g_contexts.size() >= 32 || g_contexts.find(context->handle) != g_contexts.end()) {
            return nullptr;
        }
        g_contexts.emplace(context->handle, context);
    }

    try {
        if (!AddWindowHook(context, hwnd)) {
            std::lock_guard<std::mutex> lock(g_globalMutex);
            g_contexts.erase(context->handle);
            return nullptr;
        }
        HookDescendants(context);
    } catch (...) {
        try {
            RemoveContextHooks(context);
        } catch (...) {
            // Best-effort cleanup; stale weak bindings are ignored by the subclass callback.
        }
        std::lock_guard<std::mutex> lock(g_globalMutex);
        g_contexts.erase(context->handle);
        return nullptr;
    }
    *input = context->logContext;
    PostMessageW(hwnd, PacketMessage(*context, WT_CTXOPEN),
                 reinterpret_cast<WPARAM>(context->handle), 0);
    return context->handle;
}

} // namespace

extern "C" UINT WINAPI WTInfoA(UINT category, UINT index, LPVOID output) {
    try {
        return GetContextInfo(false, category, index, output);
    } catch (...) {
        return 0;
    }
}

extern "C" UINT WINAPI WTInfoW(UINT category, UINT index, LPVOID output) {
    try {
        return GetContextInfo(true, category, index, output);
    } catch (...) {
        return 0;
    }
}

extern "C" HCTX WINAPI WTOpenA(HWND hwnd, LPLOGCONTEXTA context, BOOL enable) {
    try {
        return OpenContext(hwnd, context, enable);
    } catch (...) {
        return nullptr;
    }
}

extern "C" HCTX WINAPI WTOpenW(HWND hwnd, LPLOGCONTEXTW context, BOOL enable) {
    if (context == nullptr) return nullptr;
    try {
        LOGCONTEXTA ansi = FromWide(*context);
        const HCTX result = OpenContext(hwnd, &ansi, enable);
        if (result != nullptr) *context = ToWide(ansi);
        return result;
    } catch (...) {
        return nullptr;
    }
}

extern "C" BOOL WINAPI WTClose(HCTX handle) {
    try {
        const ContextPtr context = FindContext(handle);
        if (!context) return FALSE;
        {
            std::lock_guard<std::mutex> lock(context->mutex);
            context->enabled = false;
            context->packets.clear();
        }
        RemoveContextHooks(context);
        {
            std::lock_guard<std::mutex> lock(g_globalMutex);
            g_contexts.erase(handle);
        }
        if (IsWindow(context->window)) {
            PostMessageW(context->window, PacketMessage(*context, WT_CTXCLOSE),
                         reinterpret_cast<WPARAM>(handle), 0);
        }
        return TRUE;
    } catch (...) {
        return FALSE;
    }
}

extern "C" BOOL WINAPI WTPacket(HCTX handle, UINT serial, LPVOID output) {
    const ContextPtr context = FindContext(handle);
    if (!context) return FALSE;
    std::lock_guard<std::mutex> lock(context->mutex);
    const auto found = std::find_if(context->packets.begin(), context->packets.end(),
        [serial](const PacketRecord& packet) { return packet.serial == serial; });
    if (found == context->packets.end()) return FALSE;

    if (output != nullptr) CopyPacketToBuffer(*context, *found, output);
    context->packets.erase(context->packets.begin(), std::next(found));
    return TRUE;
}

extern "C" int WINAPI WTPacketsGet(HCTX handle, int maximum, LPVOID output) {
    try {
        return CopyQueuedPackets(FindContext(handle), maximum, output, true);
    } catch (...) {
        return 0;
    }
}

extern "C" int WINAPI WTPacketsPeek(HCTX handle, int maximum, LPVOID output) {
    try {
        return CopyQueuedPackets(FindContext(handle), maximum, output, false);
    } catch (...) {
        return 0;
    }
}

extern "C" BOOL WINAPI WTEnable(HCTX handle, BOOL enable) {
    const ContextPtr context = FindContext(handle);
    if (!context) return FALSE;
    std::lock_guard<std::mutex> lock(context->mutex);
    context->enabled = enable != FALSE;
    context->logContext.lcStatus = context->enabled ? 0 : CXS_DISABLED;
    if (!context->enabled) {
        FlushQueue(*context);
        context->inProximity = false;
        context->pointerId = 0;
        context->hasPrevious = false;
        context->hasSeenPen = false;
    }
    return TRUE;
}

extern "C" BOOL WINAPI WTOverlap(HCTX handle, BOOL toTop) {
    const ContextPtr context = FindContext(handle);
    if (!context) return FALSE;
    std::lock_guard<std::mutex> lock(context->mutex);
    context->onTop = toTop != FALSE;
    context->logContext.lcStatus =
        (context->enabled ? 0u : CXS_DISABLED) | (context->onTop ? CXS_ONTOP : 0u);
    if (!context->onTop) FlushQueue(*context);
    return TRUE;
}

extern "C" BOOL WINAPI WTGetA(HCTX handle, LPLOGCONTEXTA output) {
    if (output == nullptr) return FALSE;
    const ContextPtr context = FindContext(handle);
    if (!context) return FALSE;
    std::lock_guard<std::mutex> lock(context->mutex);
    *output = context->logContext;
    output->lcStatus = (context->enabled ? 0u : CXS_DISABLED) |
        (context->onTop ? CXS_ONTOP : 0u);
    return TRUE;
}

extern "C" BOOL WINAPI WTGetW(HCTX handle, LPLOGCONTEXTW output) {
    if (output == nullptr) return FALSE;
    const ContextPtr context = FindContext(handle);
    if (!context) return FALSE;
    std::lock_guard<std::mutex> lock(context->mutex);
    *output = ToWide(context->logContext);
    output->lcStatus = (context->enabled ? 0u : CXS_DISABLED) |
        (context->onTop ? CXS_ONTOP : 0u);
    return TRUE;
}

extern "C" BOOL WINAPI WTSetA(HCTX handle, LPLOGCONTEXTA input) {
    if (input == nullptr || input->lcDevice != 0 || input->lcMsgBase > 0xFFFFu - WT_MAXOFFSET) {
        return FALSE;
    }
    const ContextPtr context = FindContext(handle);
    if (!context) return FALSE;
    std::lock_guard<std::mutex> lock(context->mutex);
    const bool packetFormatChanged = context->logContext.lcPktData != input->lcPktData ||
        context->logContext.lcPktMode != input->lcPktMode;
    context->logContext = *input;
    if (context->logContext.lcMsgBase == 0) context->logContext.lcMsgBase = WT_DEFBASE;
    context->logContext.lcStatus = (context->enabled ? 0u : CXS_DISABLED) |
        (context->onTop ? CXS_ONTOP : 0u);
    if (packetFormatChanged) FlushQueue(*context);
    return TRUE;
}

extern "C" BOOL WINAPI WTSetW(HCTX handle, LPLOGCONTEXTW input) {
    if (input == nullptr) return FALSE;
    LOGCONTEXTA ansi = FromWide(*input);
    const BOOL result = WTSetA(handle, &ansi);
    if (result) {
        if (const ContextPtr context = FindContext(handle)) {
            std::lock_guard<std::mutex> lock(context->mutex);
            *input = ToWide(context->logContext);
        }
    }
    return result;
}

extern "C" BOOL WINAPI WTQueueSizeSet(HCTX handle, int requestedSize) {
    if (requestedSize < 1 || requestedSize > 65536) return FALSE;
    const ContextPtr context = FindContext(handle);
    if (!context) return FALSE;
    std::lock_guard<std::mutex> lock(context->mutex);
    context->queueLimit = static_cast<size_t>(requestedSize);
    while (context->packets.size() > context->queueLimit) context->packets.pop_front();
    return TRUE;
}

extern "C" int WINAPI WTQueueSizeGet(HCTX handle) {
    const ContextPtr context = FindContext(handle);
    if (!context) return 0;
    std::lock_guard<std::mutex> lock(context->mutex);
    return static_cast<int>(context->queueLimit);
}

extern "C" BOOL WINAPI WTQueuePacketsEx(HCTX handle, UINT* oldest, UINT* newest) {
    const ContextPtr context = FindContext(handle);
    if (!context || oldest == nullptr || newest == nullptr) return FALSE;
    std::lock_guard<std::mutex> lock(context->mutex);
    if (context->packets.empty()) {
        *oldest = 0;
        *newest = 0;
        return TRUE;
    }
    *oldest = context->packets.front().serial;
    *newest = context->packets.back().serial;
    return TRUE;
}

extern "C" int WINAPI WTDataGet(HCTX handle, UINT begin, UINT end, int maximum,
                                  LPVOID output, LPINT actualCount) {
    try {
        return CopyQueuedPackets(FindContext(handle), maximum, output, true,
                                 true, begin, end, actualCount);
    } catch (...) {
        if (actualCount != nullptr) *actualCount = 0;
        return 0;
    }
}

extern "C" int WINAPI WTDataPeek(HCTX handle, UINT begin, UINT end, int maximum,
                                   LPVOID output, LPINT actualCount) {
    try {
        return CopyQueuedPackets(FindContext(handle), maximum, output, false,
                                 true, begin, end, actualCount);
    } catch (...) {
        if (actualCount != nullptr) *actualCount = 0;
        return 0;
    }
}

extern "C" BOOL WINAPI WTConfig(HCTX, HWND) {
    return FALSE;
}

extern "C" BOOL WINAPI WTExtGet(HCTX, UINT, LPVOID) {
    return FALSE;
}

extern "C" BOOL WINAPI WTExtSet(HCTX, UINT, LPVOID) {
    return FALSE;
}

extern "C" BOOL WINAPI WTSave(HCTX, LPVOID) {
    return FALSE;
}

extern "C" HCTX WINAPI WTRestore(HWND, LPVOID, BOOL) {
    return nullptr;
}

// Manager APIs are present for loader compatibility. This bridge has no external manager.
extern "C" HMGR WINAPI WTMgrOpen(HWND, UINT) { return nullptr; }
extern "C" BOOL WINAPI WTMgrClose(HMGR) { return FALSE; }
extern "C" BOOL WINAPI WTMgrContextEnum(HMGR, WTENUMPROC, LPARAM) { return FALSE; }
extern "C" HWND WINAPI WTMgrContextOwner(HMGR, HCTX) { return nullptr; }
extern "C" HCTX WINAPI WTMgrDefContext(HMGR, BOOL) { return nullptr; }
extern "C" HCTX WINAPI WTMgrDefContextEx(HMGR, UINT, BOOL) { return nullptr; }
extern "C" UINT WINAPI WTMgrDeviceConfig(HMGR, UINT, HWND) { return WTDC_NONE; }
extern "C" BOOL WINAPI WTMgrExt(HMGR, UINT, LPVOID) { return FALSE; }
extern "C" BOOL WINAPI WTMgrCsrEnable(HMGR, UINT, BOOL) { return FALSE; }
extern "C" BOOL WINAPI WTMgrCsrButtonMap(HMGR, UINT, LPBYTE, LPBYTE) { return FALSE; }
extern "C" BOOL WINAPI WTMgrCsrPressureBtnMarks(HMGR, UINT, DWORD, DWORD) { return FALSE; }
extern "C" BOOL WINAPI WTMgrCsrPressureResponse(HMGR, UINT, UINT*, UINT*) { return FALSE; }
extern "C" BOOL WINAPI WTMgrCsrExt(HMGR, UINT, UINT, LPVOID) { return FALSE; }
extern "C" BOOL WINAPI WTMgrCsrPressureBtnMarksEx(HMGR, UINT, UINT*, UINT*) { return FALSE; }
extern "C" BOOL WINAPI WTMgrConfigReplaceExA(HMGR, BOOL, LPSTR, LPSTR) { return FALSE; }
extern "C" BOOL WINAPI WTMgrConfigReplaceExW(HMGR, BOOL, LPWSTR, LPSTR) { return FALSE; }
extern "C" HWTHOOK WINAPI WTMgrPacketHookExA(HMGR, int, LPSTR, LPSTR) { return nullptr; }
extern "C" HWTHOOK WINAPI WTMgrPacketHookExW(HMGR, int, LPWSTR, LPSTR) { return nullptr; }
extern "C" BOOL WINAPI WTMgrPacketUnhook(HWTHOOK) { return FALSE; }
extern "C" LRESULT WINAPI WTMgrPacketHookNext(HWTHOOK, int, WPARAM, LPARAM) { return 0; }

BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        g_module = instance;
        DisableThreadLibraryCalls(instance);
    }
    return TRUE;
}

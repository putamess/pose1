#pragma once

// Minimal WinTab-compatible ABI declarations for the x64 WM_POINTER bridge.
// These definitions intentionally avoid depending on a vendor's wintab.h.
#include <windows.h>
#include <cstddef>
#include <cstdint>

using HCTX = HANDLE;
using HMGR = HANDLE;
using HWTHOOK = HANDLE;
using WTPKT = DWORD;
using FIX32 = DWORD;

constexpr UINT WT_DEFBASE = 0x7FF0;
constexpr UINT WT_MAXOFFSET = 0x000F;
constexpr UINT WT_PACKET = WT_DEFBASE + 0;
constexpr UINT WT_CTXOPEN = WT_DEFBASE + 1;
constexpr UINT WT_CTXCLOSE = WT_DEFBASE + 2;
constexpr UINT WT_CTXUPDATE = WT_DEFBASE + 3;
constexpr UINT WT_CTXOVERLAP = WT_DEFBASE + 4;
constexpr UINT WT_PROXIMITY = WT_DEFBASE + 5;
constexpr UINT WT_INFOCHANGE = WT_DEFBASE + 6;
constexpr UINT WT_CSRCHANGE = WT_DEFBASE + 7;

constexpr UINT WTI_INTERFACE = 1;
constexpr UINT WTI_STATUS = 2;
constexpr UINT WTI_DEFCONTEXT = 3;
constexpr UINT WTI_DEFSYSCTX = 4;
constexpr UINT WTI_DEVICES = 100;
constexpr UINT WTI_CURSORS = 200;
constexpr UINT WTI_EXTENSIONS = 300;
constexpr UINT WTI_DDCTXS = 400;
constexpr UINT WTI_DSCTXS = 500;

constexpr UINT IFC_WINTABID = 1;
constexpr UINT IFC_SPECVERSION = 2;
constexpr UINT IFC_IMPLVERSION = 3;
constexpr UINT IFC_NDEVICES = 4;
constexpr UINT IFC_NCURSORS = 5;
constexpr UINT IFC_NCONTEXTS = 6;
constexpr UINT IFC_CTXOPTIONS = 7;
constexpr UINT IFC_CTXSAVESIZE = 8;
constexpr UINT IFC_NEXTENSIONS = 9;
constexpr UINT IFC_NMANAGERS = 10;

constexpr UINT STA_CONTEXTS = 1;
constexpr UINT STA_SYSCTXS = 2;
constexpr UINT STA_PKTRATE = 3;
constexpr UINT STA_PKTDATA = 4;
constexpr UINT STA_MANAGERS = 5;
constexpr UINT STA_SYSTEM = 6;
constexpr UINT STA_BUTTONUSE = 7;
constexpr UINT STA_SYSBTNUSE = 8;

constexpr UINT DVC_NAME = 1;
constexpr UINT DVC_HARDWARE = 2;
constexpr UINT DVC_NCSRTYPE = 3;
constexpr UINT DVC_FIRSTCSR = 4;
constexpr UINT DVC_PKTRATE = 5;
constexpr UINT DVC_PKTDATA = 6;
constexpr UINT DVC_PKTMODE = 7;
constexpr UINT DVC_CSRDATA = 8;
constexpr UINT DVC_XMARGIN = 9;
constexpr UINT DVC_YMARGIN = 10;
constexpr UINT DVC_ZMARGIN = 11;
constexpr UINT DVC_X = 12;
constexpr UINT DVC_Y = 13;
constexpr UINT DVC_Z = 14;
constexpr UINT DVC_NPRESSURE = 15;
constexpr UINT DVC_TPRESSURE = 16;
constexpr UINT DVC_ORIENTATION = 17;
constexpr UINT DVC_ROTATION = 18;
constexpr UINT DVC_PNPID = 19;

constexpr UINT CSR_NAME = 1;
constexpr UINT CSR_ACTIVE = 2;
constexpr UINT CSR_PKTDATA = 3;
constexpr UINT CSR_BUTTONS = 4;
constexpr UINT CSR_BUTTONBITS = 5;
constexpr UINT CSR_BTNNAMES = 6;
constexpr UINT CSR_BUTTONMAP = 7;
constexpr UINT CSR_SYSBTNMAP = 8;
constexpr UINT CSR_NPBUTTON = 9;
constexpr UINT CSR_NPBTNMARKS = 10;
constexpr UINT CSR_NPRESPONSE = 11;
constexpr UINT CSR_TPBUTTON = 12;
constexpr UINT CSR_TPBTNMARKS = 13;
constexpr UINT CSR_TPRESPONSE = 14;
constexpr UINT CSR_PHYSID = 15;
constexpr UINT CSR_MODE = 16;
constexpr UINT CSR_MINPKTDATA = 17;
constexpr UINT CSR_MINBUTTONS = 18;
constexpr UINT CSR_CAPABILITIES = 19;
constexpr UINT CSR_TYPE = 20;

constexpr WTPKT PK_CONTEXT = 0x0001;
constexpr WTPKT PK_STATUS = 0x0002;
constexpr WTPKT PK_TIME = 0x0004;
constexpr WTPKT PK_CHANGED = 0x0008;
constexpr WTPKT PK_SERIAL_NUMBER = 0x0010;
constexpr WTPKT PK_CURSOR = 0x0020;
constexpr WTPKT PK_BUTTONS = 0x0040;
constexpr WTPKT PK_X = 0x0080;
constexpr WTPKT PK_Y = 0x0100;
constexpr WTPKT PK_Z = 0x0200;
constexpr WTPKT PK_NORMAL_PRESSURE = 0x0400;
constexpr WTPKT PK_TANGENT_PRESSURE = 0x0800;
constexpr WTPKT PK_ORIENTATION = 0x1000;
constexpr WTPKT PK_ROTATION = 0x2000;

constexpr UINT CXO_SYSTEM = 0x0001;
constexpr UINT CXO_PEN = 0x0002;
constexpr UINT CXO_MESSAGES = 0x0004;
constexpr UINT CXO_CSRMESSAGES = 0x0008;
constexpr UINT CXO_MGNINSIDE = 0x4000;
constexpr UINT CXO_MARGIN = 0x8000;

constexpr UINT CXS_DISABLED = 0x0001;
constexpr UINT CXS_OBSCURED = 0x0002;
constexpr UINT CXS_ONTOP = 0x0004;

constexpr UINT TPS_PROXIMITY = 0x0001;
constexpr UINT TPS_QUEUE_ERR = 0x0002;
constexpr UINT TPS_MARGIN = 0x0004;
constexpr UINT TPS_GRAB = 0x0008;
constexpr UINT TPS_INVERT = 0x0010;

constexpr UINT TBN_NONE = 0;
constexpr UINT TBN_UP = 1;
constexpr UINT TBN_DOWN = 2;

constexpr UINT TU_NONE = 0;
constexpr UINT TU_INCHES = 1;
constexpr UINT TU_CENTIMETERS = 2;
constexpr UINT TU_CIRCLE = 3;

constexpr UINT HWC_INTEGRATED = 0x0001;
constexpr UINT HWC_TOUCH = 0x0002;
constexpr UINT HWC_HARDPROX = 0x0004;
constexpr UINT CRC_MULTIMODE = 0x0001;
constexpr UINT CRC_AGGREGATE = 0x0002;
constexpr UINT CRC_INVERT = 0x0004;

constexpr UINT WTDC_NONE = 0;
constexpr UINT WTDC_CANCEL = 1;
constexpr UINT WTDC_OK = 2;
constexpr UINT WTDC_RESTART = 3;

constexpr UINT WTX_OBT = 0;
constexpr UINT WTX_FKEYS = 1;
constexpr UINT WTX_TILT = 2;
constexpr UINT WTX_CSRMASK = 3;
constexpr UINT WTX_XBTNMASK = 4;

constexpr UINT LCNAMELEN = 40;

struct AXIS {
    LONG axMin;
    LONG axMax;
    UINT axUnits;
    FIX32 axResolution;
};

struct ORIENTATION {
    int orAzimuth;
    int orAltitude;
    int orTwist;
};

struct ROTATION {
    int roPitch;
    int roRoll;
    int roYaw;
};

struct TILT {
    int tiltX;
    int tiltY;
};

struct LOGCONTEXTA {
    char lcName[LCNAMELEN];
    UINT lcOptions;
    UINT lcStatus;
    UINT lcLocks;
    UINT lcMsgBase;
    UINT lcDevice;
    UINT lcPktRate;
    WTPKT lcPktData;
    WTPKT lcPktMode;
    WTPKT lcMoveMask;
    DWORD lcBtnDnMask;
    DWORD lcBtnUpMask;
    LONG lcInOrgX;
    LONG lcInOrgY;
    LONG lcInOrgZ;
    LONG lcInExtX;
    LONG lcInExtY;
    LONG lcInExtZ;
    LONG lcOutOrgX;
    LONG lcOutOrgY;
    LONG lcOutOrgZ;
    LONG lcOutExtX;
    LONG lcOutExtY;
    LONG lcOutExtZ;
    FIX32 lcSensX;
    FIX32 lcSensY;
    FIX32 lcSensZ;
    BOOL lcSysMode;
    int lcSysOrgX;
    int lcSysOrgY;
    int lcSysExtX;
    int lcSysExtY;
    FIX32 lcSysSensX;
    FIX32 lcSysSensY;
};

struct LOGCONTEXTW {
    WCHAR lcName[LCNAMELEN];
    UINT lcOptions;
    UINT lcStatus;
    UINT lcLocks;
    UINT lcMsgBase;
    UINT lcDevice;
    UINT lcPktRate;
    WTPKT lcPktData;
    WTPKT lcPktMode;
    WTPKT lcMoveMask;
    DWORD lcBtnDnMask;
    DWORD lcBtnUpMask;
    LONG lcInOrgX;
    LONG lcInOrgY;
    LONG lcInOrgZ;
    LONG lcInExtX;
    LONG lcInExtY;
    LONG lcInExtZ;
    LONG lcOutOrgX;
    LONG lcOutOrgY;
    LONG lcOutOrgZ;
    LONG lcOutExtX;
    LONG lcOutExtY;
    LONG lcOutExtZ;
    FIX32 lcSensX;
    FIX32 lcSensY;
    FIX32 lcSensZ;
    BOOL lcSysMode;
    int lcSysOrgX;
    int lcSysOrgY;
    int lcSysExtX;
    int lcSysExtY;
    FIX32 lcSysSensX;
    FIX32 lcSysSensY;
};

using PLOGCONTEXTA = LOGCONTEXTA*;
using LPLOGCONTEXTA = LOGCONTEXTA*;
using PLOGCONTEXTW = LOGCONTEXTW*;
using LPLOGCONTEXTW = LOGCONTEXTW*;

using WTENUMPROC = BOOL(WINAPI*)(HCTX, LPARAM);
using WTCONFIGPROC = BOOL(WINAPI*)(HCTX, HWND);
using WTHOOKPROC = LRESULT(WINAPI*)(int, WPARAM, LPARAM);

static_assert(offsetof(LOGCONTEXTA, lcOptions) == 40, "WinTab LOGCONTEXTA ABI mismatch");
static_assert(offsetof(LOGCONTEXTW, lcOptions) == 80, "WinTab LOGCONTEXTW ABI mismatch");
static_assert(sizeof(LOGCONTEXTA) == 172, "WinTab LOGCONTEXTA ABI mismatch");
static_assert(sizeof(LOGCONTEXTW) == 212, "WinTab LOGCONTEXTW ABI mismatch");

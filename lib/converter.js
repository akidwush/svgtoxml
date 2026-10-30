import { convertSvgToAlightXml as convertSvgToAlightXmlCore } from './converter-core.js';
import { withNativeContourDiagnostics } from './native-contours.js';
import {
  getFilledPathGeometryScopeStats,
  withFilledPathGeometryScope
} from './path-geometry.js';

const SMART_COLOR_GROUP_MAX_WORK_UNITS = 20_000_000;

function geometryDiagnostics(geometry) {
  if (!geometry) return null;
  return {
    engine: 'smart-color-groups',
    preparedGeometries: geometry.preparedGeometries,
    preparedSegments: geometry.preparedSegments,
    geometryCacheHits: geometry.geometryCacheHits,
    samplePreparations: geometry.samplePreparations,
    spatialNodeTests: geometry.spatialNodeTests,
    spatialNodeRejected: geometry.spatialNodeRejected,
    pointSpatialNodeTests: geometry.pointSpatialNodeTests,
    pointSpatialNodeRejected: geometry.pointSpatialNodeRejected,
    segmentBoundsTests: geometry.segmentBoundsTests,
    segmentBoundsRejected: geometry.segmentBoundsRejected,
    segmentComparisons: geometry.segmentComparisons,
    paintPointTests: geometry.paintPointTests,
    geometryWorkUnits: geometry.workUnits,
    geometryWorkLimit: geometry.maxWorkUnits
  };
}

export function convertSvgToAlightXml(svgInput, rawOptions = {}) {
  return withNativeContourDiagnostics(contours => withFilledPathGeometryScope(() => {
    try {
      const result = convertSvgToAlightXmlCore(svgInput, rawOptions);
      if(result?.stats)result.stats.nativeContours={...contours};
      if (result?.profile?.quality === 'color-group' && result.grouping) {
        const diagnostics = geometryDiagnostics(getFilledPathGeometryScopeStats());
        if (diagnostics) Object.assign(result.grouping, diagnostics);
      }
      return result;
    } catch (error) {
      if (error?.code === 'COLOR_GROUP_COMPLEXITY_LIMIT') {
        error.diagnostics = {
          ...(error.diagnostics || {}),
          ...geometryDiagnostics(getFilledPathGeometryScopeStats())
        };
      }
      throw error;
    }
  }, { maxWorkUnits: SMART_COLOR_GROUP_MAX_WORK_UNITS }));
}

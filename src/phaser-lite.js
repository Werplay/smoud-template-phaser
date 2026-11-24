// A Phaser build with only what PlayclipScene uses (tsconfig maps 'phaser'
// here for the bundle; the types still come from the phaser package).
// Phaser's prebuilt dist bundles everything (Matter and Arcade physics,
// tilemaps, particles, curves, ...): about 1.19 MB minified, the largest part
// of every playable. This is phaser-core.js (Phaser's own custom-build entry)
// plus the game objects, loaders and helpers the scene adds. A game object or
// loader registers its `this.add.*` / `this.load.*` factory when its file is
// required, so a new one the scene uses must be required here too
// (the editor repo's src/lib/phaser-build/__tests__/phaser-lite.test.ts checks the list).

require('phaser/src/polyfills/requestVideoFrame');

var CONST = require('phaser/src/const');
var Extend = require('phaser/src/utils/object/Extend');

var Phaser = {
    Animations: require('phaser/src/animations'),
    BlendModes: require('phaser/src/renderer/BlendModes'),
    Cache: require('phaser/src/cache'),
    Cameras: { Scene2D: require('phaser/src/cameras/2d') },
    Core: require('phaser/src/core'),
    Class: require('phaser/src/utils/Class'),
    Data: require('phaser/src/data'),
    Display: {
        Color: require('phaser/src/display/color'),
        Masks: require('phaser/src/display/mask')
    },
    DOM: require('phaser/src/dom'),
    Events: require('phaser/src/events'),
    FX: require('phaser/src/fx'),
    Game: require('phaser/src/core/Game'),
    GameObjects: {
        Events: require('phaser/src/gameobjects/events'),
        DisplayList: require('phaser/src/gameobjects/DisplayList'),
        GameObjectCreator: require('phaser/src/gameobjects/GameObjectCreator'),
        GameObjectFactory: require('phaser/src/gameobjects/GameObjectFactory'),
        UpdateList: require('phaser/src/gameobjects/UpdateList'),
        Components: require('phaser/src/gameobjects/components'),
        BuildGameObject: require('phaser/src/gameobjects/BuildGameObject'),
        GameObject: require('phaser/src/gameobjects/GameObject'),
        Container: require('phaser/src/gameobjects/container/Container'),
        Graphics: require('phaser/src/gameobjects/graphics/Graphics'),
        Image: require('phaser/src/gameobjects/image/Image'),
        Rectangle: require('phaser/src/gameobjects/shape/rectangle/Rectangle'),
        Text: require('phaser/src/gameobjects/text/Text'),
        Video: require('phaser/src/gameobjects/video/Video'),
        Factories: {
            Container: require('phaser/src/gameobjects/container/ContainerFactory'),
            Graphics: require('phaser/src/gameobjects/graphics/GraphicsFactory'),
            Image: require('phaser/src/gameobjects/image/ImageFactory'),
            Rectangle: require('phaser/src/gameobjects/shape/rectangle/RectangleFactory'),
            Text: require('phaser/src/gameobjects/text/TextFactory'),
            Video: require('phaser/src/gameobjects/video/VideoFactory')
        },
        Creators: {
            Graphics: require('phaser/src/gameobjects/graphics/GraphicsCreator')
        }
    },
    Geom: { Rectangle: require('phaser/src/geom/rectangle') },
    Input: require('phaser/src/input'),
    Loader: {
        FileTypes: {
            ImageFile: require('phaser/src/loader/filetypes/ImageFile'),
            VideoFile: require('phaser/src/loader/filetypes/VideoFile')
        },
        File: require('phaser/src/loader/File'),
        FileTypesManager: require('phaser/src/loader/FileTypesManager'),
        LoaderPlugin: require('phaser/src/loader/LoaderPlugin')
    },
    Plugins: require('phaser/src/plugins'),
    Renderer: require('phaser/src/renderer'),
    Scale: require('phaser/src/scale'),
    ScaleModes: require('phaser/src/renderer/ScaleModes'),
    Scene: require('phaser/src/scene/Scene'),
    Scenes: require('phaser/src/scene'),
    Sound: require('phaser/src/sound'),
    Structs: require('phaser/src/structs'),
    Textures: require('phaser/src/textures'),
    Time: require('phaser/src/time'),
    Tweens: require('phaser/src/tweens')
};

Phaser = Extend(false, Phaser, CONST);

module.exports = Phaser;

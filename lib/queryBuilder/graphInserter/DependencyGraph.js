'use strict';

const HasManyRelation = require('../../relations/hasMany/HasManyRelation');
const RelationExpression = require('../RelationExpression');
const ManyToManyRelation = require('../../relations/manyToMany/ManyToManyRelation');
const BelongsToOneRelation = require('../../relations/belongsToOne/BelongsToOneRelation');

const DependencyNode = require('./DependencyNode');
const HasManyDependency = require('./HasManyDependency');
const ManyToManyConnection = require('./ManyToManyConnection');
const ReplaceValueDependency = require('./ReplaceValueDependency');
const BelongsToOneDependency = require('./BelongsToOneDependency');
const InterpolateValueDependency = require('./InterpolateValueDependency');

class DependencyGraph {

  constructor(allowedRelations) {
    this.allowedRelations = allowedRelations;
    this.nodesById = Object.create(null);
    this.inputNodesById = Object.create(null);
    this.nodes = [];
    this.uid = 0;
  }

  build(modelClass, models) {
    this.nodesById = Object.create(null);
    this.nodes = [];

    if (Array.isArray(models)) {
      for (let i = 0, l = models.length; i < l; ++i) {
        this.buildForModel(modelClass, models[i], null, null, this.allowedRelations);
      }
    } else {
      this.buildForModel(modelClass, models, null, null, this.allowedRelations);
    }

    this.solveReferences();
    this.createNonRelationDeps();

    if (this.isCyclic(this.nodes)) {
      throw modelClass.createValidationError({cyclic: 'the object graph contains cyclic references'});
    }

    return this.nodes;
  };

  buildForModel(modelClass, model, parentNode, rel, allowedRelations) {
    if (!model || !model.$isObjectionModel) {
      throw modelClass.createValidationError({notModel: 'not a model'});
    }

    if (!model[modelClass.uidProp]) {
      model[modelClass.uidProp] = this.createUid();
    }

    const node = new DependencyNode(parentNode, model, modelClass);

    this.nodesById[node.id] = node;
    this.nodes.push(node);

    if (!parentNode) {
      this.inputNodesById[node.id] = node;
    }

    if (rel) {
      if (rel instanceof HasManyRelation) {

        node.needs.push(new HasManyDependency(parentNode, rel));
        parentNode.isNeededBy.push(new HasManyDependency(node, rel));

      } else if (rel instanceof BelongsToOneRelation) {

        node.isNeededBy.push(new BelongsToOneDependency(parentNode, rel));
        parentNode.needs.push(new BelongsToOneDependency(node, rel));

      } else if (rel instanceof ManyToManyRelation) {

        // ManyToManyRelations create no dependencies since we can create the
        // join table rows after everything else has been inserted.
        parentNode.manyToManyConnections.push(new ManyToManyConnection(node, rel));

      }
    }

    this.buildForRelations(modelClass, node, allowedRelations);
  }

  buildForRelations(modelClass, node, allowedRelations) {
    const model = node.model;
    const relations = modelClass.getRelationArray();

    for (let i = 0, l = relations.length; i < l; ++i) {
      const rel = relations[i];
      const relModels = model[rel.name];

      let nextAllowed = null;

      if (relModels && allowedRelations instanceof RelationExpression) {
        nextAllowed = allowedRelations.childExpression(rel.name);

        if (!nextAllowed) {
          throw modelClass.createValidationError({allowedRelations: 'trying to insert an unallowed relation'});
        }
      }

      if (Array.isArray(relModels)) {
        for (let i = 0, l = relModels.length; i < l; ++i) {
          this.buildForItem(rel.relatedModelClass, relModels[i], node, rel, nextAllowed);
        }
      } else if (relModels) {
        this.buildForItem(rel.relatedModelClass, relModels, node, rel, nextAllowed);
      }
    }
  }

  buildForItem(modelClass, item, parentNode, rel, allowedRelations) {
    if (rel instanceof ManyToManyRelation && item[modelClass.dbRefProp]) {
      this.buildForId(modelClass, item, parentNode, rel, allowedRelations);
    } else {
      this.buildForModel(modelClass, item, parentNode, rel, allowedRelations);
    }
  }

  buildForId(modelClass, item, parentNode, rel) {
    const node = new DependencyNode(parentNode, item, modelClass);
    node.handled = true;

    item.$id(item[modelClass.dbRefProp]);
    parentNode.manyToManyConnections.push(new ManyToManyConnection(node, rel));
  }

  solveReferences() {
    const refMap = Object.create(null);

    // First merge all reference nodes into the actual node.
    this.mergeReferences(refMap);

    // Replace all reference nodes with the actual nodes.
    this.replaceReferenceNodes(refMap);
  }

  mergeReferences(refMap) {
    for (let n = 0, ln = this.nodes.length; n < ln; ++n) {
      const refNode = this.nodes[n];
      let ref;

      if (refNode.handled) {
        continue;
      }

      ref = refNode.model[refNode.modelClass.uidRefProp];

      if (ref) {
        const actualNode = this.nodesById[ref];
        let d, ld;

        if (!actualNode) {
          throw refNode.modelClass.createValidationError({ref: `could not resolve reference "${ref}"`});
        }

        for (d = 0, ld = refNode.needs.length; d < ld; ++d) {
          actualNode.needs.push(refNode.needs[d]);
        }

        for (d = 0, ld = refNode.isNeededBy.length; d < ld; ++d) {
          actualNode.isNeededBy.push(refNode.isNeededBy[d]);
        }

        for (let m = 0, lm = refNode.manyToManyConnections.length; m < lm; ++m) {
          actualNode.manyToManyConnections.push(refNode.manyToManyConnections[m]);
        }

        refMap[refNode.id] = actualNode;
        refNode.handled = true;
      }
    }
  }

  replaceReferenceNodes(refMap) {
    for (let n = 0, ln = this.nodes.length; n < ln; ++n) {
      const node = this.nodes[n];
      let d, ld, dep, actualNode;

      for (d = 0, ld = node.needs.length; d < ld; ++d) {
        dep = node.needs[d];
        actualNode = refMap[dep.node.id];

        if (actualNode) {
          dep.node = actualNode;
        }
      }

      for (d = 0, ld = node.isNeededBy.length; d < ld; ++d) {
        dep = node.isNeededBy[d];
        actualNode = refMap[dep.node.id];

        if (actualNode) {
          dep.node = actualNode;
        }
      }

      for (let m = 0, lm = node.manyToManyConnections.length; m < lm; ++m) {
        const conn = node.manyToManyConnections[m];
        actualNode = refMap[conn.node.id];

        if (actualNode) {
          conn.refNode = conn.node;
          conn.node = actualNode;
        }
      }
    }
  }

  createNonRelationDeps() {
    for (let n = 0, ln = this.nodes.length; n < ln; ++n) {
      const node = this.nodes[n];

      if (!node.handled) {
        this.createNonRelationDepsForObject(node.model, node, []);
      }
    }
  }

  createNonRelationDepsForObject(obj, node, path) {
    const propRefRegex = node.modelClass.propRefRegex;
    const relations = node.modelClass.getRelations();
    const isModel = obj && obj.$isObjectionModel;
    const keys = Object.keys(obj);

    for (let i = 0, l = keys.length; i < l; ++i) {
      const key = keys[i];
      const value = obj[key];

      if (isModel && relations[key]) {
        // Don't traverse the relations of model instances.
        return;
      }

      path.push(key);

      if (typeof value === 'string') {
        allMatches(propRefRegex, value, matchResult => {
          const match = matchResult[0];
          const refId = matchResult[1];
          const refProp = matchResult[2];
          const refNode = this.nodesById[refId];

          if (!refNode) {
            throw node.modelClass.createValidationError({ref: `could not resolve reference "${value}"`});
          }

          if (value === match) {
            // If the match is the whole string, replace the value with the resolved value.
            // This means that the value will have the same type as the resolved value
            // (date, number, etc).
            node.needs.push(new ReplaceValueDependency(refNode, path, refProp, false));
            refNode.isNeededBy.push(new ReplaceValueDependency(node, path, refProp, true));
          } else {
            // If the match is inside a string, replace the reference inside the string with
            // the resolved value.
            node.needs.push(new InterpolateValueDependency(refNode, path, refProp, match, false));
            refNode.isNeededBy.push(new InterpolateValueDependency(node, path, refProp, match, true));
          }
        });
      } else if (value && typeof value === 'object') {
        this.createNonRelationDepsForObject(value, node, path);
      }

      path.pop();
    }
  }

  isCyclic(nodes) {
    let isCyclic = false;

    for (let n = 0, ln = nodes.length; n < ln; ++n) {
      let node = nodes[n];

      if (node.handled) {
        continue;
      }

      if (this.isCyclicNode(node)) {
        isCyclic = true;
        break;
      }
    }

    this.clearFlags(this.nodes);
    return isCyclic;
  }

  isCyclicNode(node) {
    if (!node.visited) {
      node.visited = true;
      node.recursion = true;

      for (let d = 0, ld = node.needs.length; d < ld; ++d) {
        let dep = node.needs[d];

        if (!dep.node.visited && this.isCyclicNode(dep.node)) {
          return true;
        } else if (dep.node.recursion) {
          return true;
        }
      }
    }

    node.recursion = false;
    return false;
  }

  clearFlags(nodes) {
    for (let n = 0, ln = nodes.length; n < ln; ++n) {
      let node = nodes[n];

      node.visited = false;
      node.recursion = false;
    }
  }

  createUid() {
    return `__objection_uid(${++this.uid})__`;
  }
}

function allMatches(regex, str, cb) {
  let matchResult = regex.exec(str);

  while (matchResult) {
    cb(matchResult);
    matchResult = regex.exec(str);
  }
}

module.exports = DependencyGraph;
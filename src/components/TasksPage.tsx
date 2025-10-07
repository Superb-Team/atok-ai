import React, { useState } from 'react';
import { Plus, CheckCircle2, Circle, Clock, GripVertical } from 'lucide-react';
import { Progress } from '@/components/ui/progress';
import { Button } from '@/components/ui/button';
import {
  DndContext,
  DragOverlay,
  closestCorners,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragStartEvent,
  DragOverEvent,
  DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

interface Task {
  id: string;
  title: string;
  duration: string;
  completed: boolean;
  date?: string;
}

interface Column {
  id: string;
  title: string;
  tasks: Task[];
  color: string;
}

// Sortable Task Component
interface SortableTaskProps {
  task: Task;
  index: number;
  columnId: string;
  toggleTaskCompletion: (columnId: string, taskId: string) => void;
}

const SortableTask: React.FC<SortableTaskProps> = ({ task, index, columnId, toggleTaskCompletion }) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="bg-secondary/30 dark:bg-muted/50 rounded-lg md:rounded-xl p-3 md:p-4 hover:shadow-md hover:bg-secondary/50 dark:hover:bg-muted transition-all border border-border/50 cursor-grab active:cursor-grabbing"
      {...attributes}
      {...listeners}
    >
      <div className="flex items-start justify-between mb-1 md:mb-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 md:gap-2 mb-1">
            <GripVertical className="w-3 h-3 md:w-4 md:h-4 text-muted-foreground flex-shrink-0" />
            <span className="text-xs md:text-sm font-medium text-muted-foreground flex-shrink-0">
              {index + 1}.
            </span>
            <h3 className={`text-xs md:text-sm font-semibold truncate ${task.completed ? 'line-through text-muted-foreground' : 'text-foreground'}`}>
              {task.title}
            </h3>
          </div>
          <div className="flex items-center gap-1.5 md:gap-2 ml-7 md:ml-9">
            <Clock className="w-2.5 h-2.5 md:w-3 md:h-3 text-muted-foreground flex-shrink-0" />
            <span className="text-xs text-muted-foreground">
              {task.duration}
            </span>
          </div>
          {task.completed && columnId === 'today' && (
            <div className="ml-7 md:ml-9 mt-1">
              <span className="inline-block px-1.5 md:px-2 py-0.5 bg-primary/20 text-primary text-xs rounded font-medium">
                Prep
              </span>
            </div>
          )}
        </div>
        <button 
          onClick={() => toggleTaskCompletion(columnId, task.id)}
          className="p-1 md:p-1.5 hover:bg-accent rounded-full transition-colors flex-shrink-0"
        >
          {task.completed ? (
            <CheckCircle2 className="w-3 h-3 md:w-4 md:h-4 text-primary" />
          ) : (
            <Circle className="w-3 h-3 md:w-4 md:h-4 text-muted-foreground hover:text-foreground" />
          )}
        </button>
      </div>
    </div>
  );
};

const TasksPage: React.FC = () => {
  const [columns, setColumns] = useState<Column[]>([
    {
      id: 'backlog',
      title: 'Backlog',
      color: 'gray',
      tasks: []
    },
    {
      id: 'thisweek',
      title: 'This Week',
      color: 'blue',
      tasks: []
    },
    {
      id: 'today',
      title: 'Today',
      color: 'blue',
      tasks: [
        { id: '1', title: 'Walk The Dog', duration: '20 Min', completed: false },
        { id: '2', title: 'Review Code', duration: '30 Min', completed: false },
        { id: '3', title: 'Team Meeting', duration: '45 Min', completed: false }
      ]
    },
    {
      id: 'done',
      title: 'Done',
      color: 'green',
      tasks: [
        { id: '4', title: 'Morning Exercise', duration: '20 Min', completed: true, date: 'Mon 1 Sep 2025' }
      ]
    }
  ]);

  const [newTaskInput, setNewTaskInput] = useState<{ [key: string]: string }>({});
  const [activeId, setActiveId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleDragStart = (event: DragStartEvent) => {
    const { active } = event;
    setActiveId(active.id as string);
  };

  const handleDragOver = (event: DragOverEvent) => {
    const { active, over } = event;
    if (!over) return;

    const activeId = active.id as string;
    const overId = over.id as string;

    const activeColumn = columns.find(col => 
      col.tasks.some(task => task.id === activeId)
    );
    const overColumn = columns.find(col => 
      col.id === overId || col.tasks.some(task => task.id === overId)
    );

    if (!activeColumn || !overColumn) return;
    if (activeColumn.id === overColumn.id) return;

    setColumns(prev => {
      const activeItems = activeColumn.tasks;
      const overItems = overColumn.tasks;

      const activeIndex = activeItems.findIndex(task => task.id === activeId);
      const overIndex = overItems.findIndex(task => task.id === overId);

      let newIndex: number;
      if (overId in prev) {
        newIndex = overItems.length;
      } else {
        const isBelowLastItem = over && overIndex === overItems.length - 1;
        const modifier = isBelowLastItem ? 1 : 0;
        newIndex = overIndex >= 0 ? overIndex + modifier : overItems.length;
      }

      return prev.map(col => {
        if (col.id === activeColumn.id) {
          return {
            ...col,
            tasks: col.tasks.filter(task => task.id !== activeId)
          };
        }
        if (col.id === overColumn.id) {
          const newTasks = [...col.tasks];
          newTasks.splice(newIndex, 0, activeItems[activeIndex]);
          return {
            ...col,
            tasks: newTasks
          };
        }
        return col;
      });
    });
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over) {
      setActiveId(null);
      return;
    }

    const activeId = active.id as string;
    const overId = over.id as string;

    const activeColumn = columns.find(col => 
      col.tasks.some(task => task.id === activeId)
    );

    if (!activeColumn) {
      setActiveId(null);
      return;
    }

    const activeIndex = activeColumn.tasks.findIndex(task => task.id === activeId);
    const overIndex = activeColumn.tasks.findIndex(task => task.id === overId);

    if (activeIndex !== overIndex && activeIndex !== -1 && overIndex !== -1) {
      setColumns(prev => prev.map(col => {
        if (col.id === activeColumn.id) {
          return {
            ...col,
            tasks: arrayMove(col.tasks, activeIndex, overIndex)
          };
        }
        return col;
      }));
    }

    setActiveId(null);
  };

  const addTask = (columnId: string) => {
    const taskTitle = newTaskInput[columnId]?.trim();
    if (!taskTitle) return;

    const newTask: Task = {
      id: Date.now().toString(),
      title: taskTitle,
      duration: '20 Min',
      completed: false
    };

    setColumns(prev => prev.map(col => 
      col.id === columnId 
        ? { ...col, tasks: [...col.tasks, newTask] }
        : col
    ));

    setNewTaskInput(prev => ({ ...prev, [columnId]: '' }));
  };

  const clearAllTasks = (columnId: string) => {
    setColumns(prev => prev.map(col => 
      col.id === columnId 
        ? { ...col, tasks: [] }
        : col
    ));
  };

  const toggleTaskCompletion = (columnId: string, taskId: string) => {
    setColumns(prev => prev.map(col => {
      if (col.id === columnId) {
        return {
          ...col,
          tasks: col.tasks.map(task => 
            task.id === taskId 
              ? { ...task, completed: !task.completed }
              : task
          )
        };
      }
      return col;
    }));
  };

  const getTaskCount = (columnId: string) => {
    const column = columns.find(col => col.id === columnId);
    return column?.tasks.length || 0;
  };

  const getProgressPercentage = (columnId: string) => {
    const column = columns.find(col => col.id === columnId);
    if (!column || column.tasks.length === 0) return 0;
    const completed = column.tasks.filter(t => t.completed).length;
    return Math.round((completed / column.tasks.length) * 100);
  };

  const getCompletedCount = (columnId: string) => {
    const column = columns.find(col => col.id === columnId);
    if (!column) return 0;
    return column.tasks.filter(t => t.completed).length;
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      <div className="flex-1 p-4 md:p-6 lg:p-8 bg-background min-h-screen overflow-x-hidden">
        <div className="max-w-7xl mx-auto">
          <h1 className="text-2xl md:text-3xl lg:text-4xl font-bold mb-4 md:mb-6 lg:mb-8 text-foreground">Tasks</h1>
          
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 md:gap-5 lg:gap-6">
            {columns.map(column => (
              <div
                key={column.id}
                className="bg-card rounded-xl md:rounded-2xl p-4 md:p-5 lg:p-6 shadow-sm border border-border flex flex-col h-[500px] md:h-[550px] lg:h-[600px] hover:shadow-lg transition-shadow"
              >
                {/* Column Header */}
                <div className="mb-3 md:mb-4">
                  <div className="flex items-center justify-between mb-2 md:mb-3">
                    <h2 className="text-lg md:text-xl font-bold text-foreground">
                      {column.title}
                    </h2>
                    {column.id === 'done' && getTaskCount(column.id) > 0 && (
                      <span className="text-xs text-muted-foreground">
                        {getTaskCount(column.id)} Task{getTaskCount(column.id) > 1 ? 's' : ''} this Month
                      </span>
                    )}
                  </div>

                  {/* Progress Bar - Fully Functional */}
                  {(column.id === 'thisweek' || column.id === 'today') && getTaskCount(column.id) > 0 && (
                    <div className="mb-3">
                      <div className="flex items-center gap-2 mb-1">
                        <Progress value={getProgressPercentage(column.id)} className="flex-1" />
                        <span className="text-xs text-muted-foreground min-w-[40px] text-right">
                          {getCompletedCount(column.id)}/{getTaskCount(column.id)}
                        </span>
                      </div>
                      <div className="text-xs text-muted-foreground text-right">
                        {getProgressPercentage(column.id)}% Complete
                      </div>
                    </div>
                  )}

                  {/* Date badge for Done column */}
                  {column.id === 'done' && column.tasks.length > 0 && (
                    <div className="flex items-center justify-between text-xs text-muted-foreground mb-2">
                      <span>{column.tasks[0].date}</span>
                      <span>{getTaskCount(column.id)} Task{getTaskCount(column.id) > 1 ? 's' : ''}</span>
                    </div>
                  )}
                </div>

                {/* Add Task Input */}
                <div className="mb-3 md:mb-4">
                  <Button
                    variant="ghost"
                    className="w-full justify-start gap-2 h-auto py-1.5 md:py-2 px-2 md:px-3 font-medium uppercase tracking-wide text-xs hover:bg-accent/50"
                    onClick={() => {
                      const input = document.querySelector(`input[data-column="${column.id}"]`) as HTMLInputElement;
                      input?.focus();
                    }}
                  >
                    <Plus className="w-3 h-3 md:w-4 md:h-4" />
                    <span className="text-xs">ADD TASK</span>
                  </Button>
                  <input
                    type="text"
                    data-column={column.id}
                    placeholder="Type task name..."
                    value={newTaskInput[column.id] || ''}
                    onChange={(e) => setNewTaskInput(prev => ({ ...prev, [column.id]: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        addTask(column.id);
                      }
                    }}
                    className="w-full mt-2 px-2 md:px-3 py-1.5 md:py-2 bg-muted/30 border border-border rounded-md outline-none text-xs md:text-sm placeholder:text-muted-foreground/70 focus:border-ring focus:ring-2 focus:ring-ring/20"
                  />
                  <div className="h-px bg-border/60 mt-2 md:mt-3" />
                </div>

                {/* Droppable Tasks List with Custom Scrollbar */}
                <SortableContext
                  items={column.tasks.map(task => task.id)}
                  strategy={verticalListSortingStrategy}
                  id={column.id}
                >
                  <div className="flex-1 overflow-y-auto space-y-2 md:space-y-3 mb-3 md:mb-4 pr-1">
                    {column.tasks.map((task, index) => (
                      <SortableTask
                        key={task.id}
                        task={task}
                        index={index}
                        columnId={column.id}
                        toggleTaskCompletion={toggleTaskCompletion}
                      />
                    ))}
                  </div>
                </SortableContext>

                {/* Clear All Button */}
                {column.tasks.length > 0 && (
                  <Button
                    onClick={() => clearAllTasks(column.id)}
                    variant="secondary"
                    className="mt-auto w-full text-xs md:text-sm py-2 md:py-2.5"
                    size="sm"
                  >
                    <CheckCircle2 className="w-4 h-4 md:w-5 md:h-5" />
                    <span>All Clear</span>
                  </Button>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Drag Overlay */}
      <DragOverlay>
        {activeId ? (
          <div className="bg-secondary/30 dark:bg-muted/50 rounded-lg md:rounded-xl p-3 md:p-4 shadow-2xl border border-border/50 rotate-3 opacity-90">
            <div className="flex items-center gap-2">
              <GripVertical className="w-4 h-4 text-muted-foreground" />
              <span className="text-sm font-semibold text-foreground">
                {columns.flatMap(col => col.tasks).find(task => task.id === activeId)?.title}
              </span>
            </div>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
};

export default TasksPage;
